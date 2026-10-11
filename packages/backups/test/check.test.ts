import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checkTarget } from '../src/check.ts';
import type { SshTarget } from '../src/connect.ts';
import { expectedFingerprint, listing, startTestTarget, type TestTarget } from './sftp-server.ts';

let far: string;
let target: TestTarget;

function describing(overrides: Partial<SshTarget> = {}): SshTarget {
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
  far = await mkdtemp(join(tmpdir(), 'knoverge-check-far-'));
  await mkdir(join(far, 'copies'));
  target = await startTestTarget({ root: far, password: 'the password' });
});

afterEach(async () => {
  await target.close();
  await chmod(join(far, 'copies'), 0o700).catch(() => undefined);
  await rm(far, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('checking the target before a copy is sent to it', () => {
  it('says all three things worked, and leaves nothing behind', async () => {
    const check = await checkTarget({
      target: describing(),
      secret: target.clientKey,
      knownHostFingerprint: null,
    });

    expect(check).toEqual({
      connected: true,
      directoryExists: true,
      writable: true,
      hostFingerprint: expectedFingerprint(target.hostKeyPublic),
      error: null,
    });
    // The point of the check is that it is not an upload: the directory
    // somebody restores from looks exactly as it did.
    expect(listing(join(far, 'copies'))).toEqual([]);
  });

  it('works with a password, which is the other thing the form offers', async () => {
    const check = await checkTarget({
      target: describing({ authKind: 'password' }),
      secret: 'the password',
      knownHostFingerprint: null,
    });

    expect(check.writable).toBe(true);
    expect(check.error).toBeNull();
  });

  it('stops at the credential, and says so', async () => {
    // A password, because the test target accepts any public key on purpose —
    // verifying a signature there would be testing `ssh2` against itself. What
    // matters here is the stage this stops at, which is the same either way.
    const check = await checkTarget({
      target: describing({ authKind: 'password' }),
      secret: 'not the password',
      knownHostFingerprint: null,
    });

    expect(check.connected).toBe(false);
    expect(check.directoryExists).toBe(false);
    expect(check.writable).toBe(false);
    expect(check.error).toMatch(/authentication/iu);
  });

  it('stops at the directory, and names the one that is not there', async () => {
    const check = await checkTarget({
      target: describing({ directory: '/copies/nowhere' }),
      secret: target.clientKey,
      knownHostFingerprint: null,
    });

    expect(check.connected).toBe(true);
    expect(check.directoryExists).toBe(false);
    expect(check.writable).toBe(false);
    expect(check.error).toBe('the directory /copies/nowhere does not exist on the target machine');
    // Nothing is created: the operator typed that path, and a check that made
    // the tree would report success for a directory nobody meant.
    expect(listing(join(far, 'copies'))).toEqual([]);
  });

  it('stops at the write, for a directory that is there and refuses a file', async () => {
    // What an account with read-only access to the copies looks like: the
    // directory stats fine and nothing can be put in it. This is the failure
    // that only a check that writes can find.
    await chmod(join(far, 'copies'), 0o500);

    const check = await checkTarget({
      target: describing(),
      secret: target.clientKey,
      knownHostFingerprint: null,
    });

    expect(check.connected).toBe(true);
    expect(check.directoryExists).toBe(true);
    expect(check.writable).toBe(false);
    expect(check.error).toMatch(/^the directory \/copies cannot be written to: /u);
  });

  it('reports the fingerprint even when the rest failed', async () => {
    // Somebody comparing this against their own `ssh-keyscan` is doing it
    // because they do not trust the machine yet, and a mistyped directory is
    // no reason to withhold the one fact they came for.
    const check = await checkTarget({
      target: describing({ directory: '/nowhere' }),
      secret: target.clientKey,
      knownHostFingerprint: null,
    });

    expect(check.hostFingerprint).toBe(expectedFingerprint(target.hostKeyPublic));
  });

  it('refuses a machine presenting a key other than the pinned one', async () => {
    const check = await checkTarget({
      target: describing(),
      secret: target.clientKey,
      knownHostFingerprint: 'SHA256:somethingelse',
    });

    expect(check.connected).toBe(false);
    expect(check.error).toMatch(/the host key of 127\.0\.0\.1 changed/u);
    expect(check.error).toContain('SHA256:somethingelse');
  });

  it('accepts the machine whose key is already pinned', async () => {
    const check = await checkTarget({
      target: describing(),
      secret: target.clientKey,
      knownHostFingerprint: expectedFingerprint(target.hostKeyPublic),
    });

    expect(check.writable).toBe(true);
    expect(check.error).toBeNull();
  });

  it('says nothing answered when nothing is listening', async () => {
    await target.close();

    const check = await checkTarget({
      target: describing(),
      secret: target.clientKey,
      knownHostFingerprint: null,
    });

    expect(check.connected).toBe(false);
    expect(check.hostFingerprint).toBeNull();
    expect(check.error).not.toBeNull();
  });
});
