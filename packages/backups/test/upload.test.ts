import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { uploadBackup, type UploadTarget } from '../src/upload.ts';
import {
  expectedFingerprint,
  keyPair,
  listing,
  startTestTarget,
  type TestTarget,
} from './sftp-server.ts';

const NAME = '20261010T090000Z';

let local: string;
let far: string;
let copy: string;
let target: TestTarget;

/** A finished copy on this machine: the three files a backup is. */
async function aCopy(): Promise<string> {
  const path = join(local, NAME);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'postgres.dump'), 'PGDMP pretend', 'utf8');
  await writeFile(join(path, 'data.tar.gz'), 'pretend archive', 'utf8');
  await writeFile(join(path, 'manifest.txt'), 'order=postgres-then-data\n', 'utf8');
  return path;
}

function describing(overrides: Partial<UploadTarget> = {}): UploadTarget {
  return {
    host: '127.0.0.1',
    port: target.port,
    username: 'knoverge',
    directory: '/copies',
    authKind: 'private_key',
    ...overrides,
  };
}

beforeEach(async () => {
  local = await mkdtemp(join(tmpdir(), 'knoverge-upload-local-'));
  far = await mkdtemp(join(tmpdir(), 'knoverge-upload-far-'));
  copy = await aCopy();
  await mkdir(join(far, 'copies'));
  target = await startTestTarget({ root: far, password: 'the password' });
});

afterEach(async () => {
  await target.close();
  for (const dir of [local, far])
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('sending a copy to the other machine', () => {
  it('puts the three files under a directory named after the copy', async () => {
    const result = await uploadBackup({
      path: copy,
      name: NAME,
      target: describing(),
      secret: target.clientKey,
      knownHostFingerprint: null,
    });

    expect(listing(join(far, 'copies'))).toEqual([`${NAME}/`]);
    expect(listing(join(far, 'copies', NAME))).toEqual([
      'data.tar.gz',
      'manifest.txt',
      'postgres.dump',
    ]);
    // The bytes, not just the names: a transfer that wrote empty files would
    // pass every other assertion here.
    expect(await readFile(join(far, 'copies', NAME, 'postgres.dump'), 'utf8')).toBe(
      'PGDMP pretend',
    );
    expect(result.hostFingerprint).toBe(expectedFingerprint(target.hostKeyPublic));
  });

  it('authenticates with a password when that is what the operator chose', async () => {
    await uploadBackup({
      path: copy,
      name: NAME,
      target: describing({ authKind: 'password' }),
      secret: 'the password',
      knownHostFingerprint: null,
    });

    expect(listing(join(far, 'copies'))).toEqual([`${NAME}/`]);
  });

  it('refuses the wrong password rather than leaving a directory behind', async () => {
    await expect(
      uploadBackup({
        path: copy,
        name: NAME,
        target: describing({ authKind: 'password' }),
        secret: 'not the password',
        knownHostFingerprint: null,
      }),
    ).rejects.toThrow(/authentication/iu);

    // Nothing created, and the reason is the real one: the host key message is
    // reserved for a key that changed, and reporting it here would send an
    // operator looking for the wrong fact.
    expect(listing(join(far, 'copies'))).toEqual([]);
    await expect(
      uploadBackup({
        path: copy,
        name: NAME,
        target: describing({ authKind: 'password' }),
        secret: 'not the password',
        knownHostFingerprint: null,
      }),
    ).rejects.not.toThrow(/host key/u);
  });

  it('says which directory is missing instead of creating one', async () => {
    await expect(
      uploadBackup({
        path: copy,
        name: NAME,
        target: describing({ directory: '/somewhere-else' }),
        secret: target.clientKey,
        knownHostFingerprint: null,
      }),
    ).rejects.toThrow('the directory /somewhere-else does not exist on the target machine');

    // Nothing was created on the way to finding out. The operator typed that
    // path, and a tree where they did not mean one is a backup nobody looks at.
    expect(listing(far)).toEqual(['copies/']);
  });

  it('leaves nothing that looks like a backup when the transfer dies halfway', async () => {
    // A copy whose second file cannot be read: the first arrives, the second
    // fails, and what is on the far end must not be named like a finished copy.
    await rm(join(copy, 'manifest.txt'));
    await mkdir(join(copy, 'manifest.txt'));

    await expect(
      uploadBackup({
        path: copy,
        name: NAME,
        target: describing(),
        secret: target.clientKey,
        knownHostFingerprint: null,
      }),
    ).rejects.toThrow();

    expect(listing(join(far, 'copies'))).toEqual([`${NAME}.partial/`]);
  });

  it('reuses and empties the staging directory a dead run left', async () => {
    await mkdir(join(far, 'copies', `${NAME}.partial`));
    // One of the three, which the new transfer overwrites, and one that nothing
    // would overwrite. Without the second, a run that never emptied the
    // directory would still pass this.
    await writeFile(join(far, 'copies', `${NAME}.partial`, 'postgres.dump'), 'half of one', 'utf8');
    await writeFile(join(far, 'copies', `${NAME}.partial`, 'half.tar.gz.tmp'), 'junk', 'utf8');

    await uploadBackup({
      path: copy,
      name: NAME,
      target: describing(),
      secret: target.clientKey,
      knownHostFingerprint: null,
    });

    expect(listing(join(far, 'copies', NAME))).toEqual([
      'data.tar.gz',
      'manifest.txt',
      'postgres.dump',
    ]);
    expect(await readFile(join(far, 'copies', NAME, 'postgres.dump'), 'utf8')).toBe(
      'PGDMP pretend',
    );
  });
});

describe('the pinned host key', () => {
  it('accepts the key it pinned', async () => {
    const pinned = expectedFingerprint(target.hostKeyPublic);

    const result = await uploadBackup({
      path: copy,
      name: NAME,
      target: describing(),
      secret: target.clientKey,
      knownHostFingerprint: pinned,
    });

    expect(result.hostFingerprint).toBe(pinned);
  });

  it('refuses a different key and says which fact changed', async () => {
    // Another machine answering on the same address. Whether it is a rebuilt
    // server or somebody in the middle, this cannot tell — which is why it
    // stops rather than guessing.
    const somebodyElse = keyPair();
    const pinned = expectedFingerprint(somebodyElse.public);

    await expect(
      uploadBackup({
        path: copy,
        name: NAME,
        target: describing(),
        secret: target.clientKey,
        knownHostFingerprint: pinned,
      }),
    ).rejects.toThrow(/host key of 127\.0\.0\.1 changed/u);

    // And nothing was sent: a backup must not reach a machine that failed to
    // prove it is the one the operator configured.
    expect(listing(join(far, 'copies'))).toEqual([]);
  });

  it('accepts the same machine answering on another port', async () => {
    // The pin is a fact about a machine, and the check is of the key rather
    // than of the address — which is what makes it a pin at all. The service
    // still clears the pin when the port changes, because another port can be
    // another machine and that is not something this can tell.
    const machine = keyPair();
    const first = await startTestTarget({ root: far, hostKey: machine });
    const second = await startTestTarget({ root: far, hostKey: machine });
    try {
      const pinned = (
        await uploadBackup({
          path: copy,
          name: NAME,
          target: describing({ port: first.port }),
          secret: first.clientKey,
          knownHostFingerprint: null,
        })
      ).hostFingerprint;

      const again = await uploadBackup({
        path: copy,
        name: '20261011T090000Z',
        target: describing({ port: second.port }),
        secret: second.clientKey,
        knownHostFingerprint: pinned,
      });

      expect(again.hostFingerprint).toBe(pinned);
      expect(listing(join(far, 'copies'))).toEqual([`${NAME}/`, '20261011T090000Z/'].sort());
    } finally {
      await first.close();
      await second.close();
    }
  });
});
