import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FileAttachmentStore, contentHash } from '../src/store.ts';

let dataDir: string;
let store: FileAttachmentStore;
const workspace = 'ws_01J8Z3M4Q9V0X7K2B5N6P8R1T3';

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'knoverge-attachments-'));
  store = new FileAttachmentStore(dataDir);
});

afterAll(async () => {
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

const bytes = (text: string) => new TextEncoder().encode(text);

describe('a file kept by the hash of its contents', () => {
  it('is written where the data directory already puts things', async () => {
    const stored = await store.put(workspace, bytes('The support hours are nine to five.\n'));
    expect(stored.created).toBe(true);

    // Beside `repositories/<workspace id>`, one directory per kind of thing with
    // the workspace under it (ADR 0008). A reader with the data directory and no
    // application can find a file from the hash in the database.
    const path = join(dataDir, 'attachments', workspace, stored.hash.replace('sha256:', ''));
    expect(await readFile(path, 'utf8')).toBe('The support hours are nine to five.\n');
  });

  it('is the same file when the same bytes arrive again', async () => {
    const first = await store.put(workspace, bytes('Twice sent, once kept.\n'));
    const second = await store.put(workspace, bytes('Twice sent, once kept.\n'));
    expect(second.hash).toBe(first.hash);
    // Said out loud, because the caller has a row to decide about: a second
    // upload of one file is one attachment, not two rows pointing at one path.
    expect(second.created).toBe(false);

    const held = await readdir(join(dataDir, 'attachments', workspace));
    expect(held.filter((name) => name === first.hash.replace('sha256:', ''))).toHaveLength(1);
  });

  it('hashes the way the rest of this product writes a hash', async () => {
    const content = bytes('The hash is over the bytes, not over a description of them.\n');
    const expected = `sha256:${createHash('sha256').update(content).digest('hex')}`;
    // Computed here rather than asked of the product: a test that calls the
    // function it is checking passes whatever that function starts doing.
    expect(contentHash(content)).toBe(expected);
    expect((await store.put(workspace, content)).hash).toBe(expected);
  });

  it('leaves nothing half-written behind', async () => {
    await store.put(workspace, bytes('Finished.\n'));
    const held = await readdir(join(dataDir, 'attachments', workspace));
    // A process killed between the write and the rename leaves a `.part` file
    // under a name nobody asks for; a finished put leaves none at all.
    expect(held.filter((name) => name.endsWith('.part'))).toEqual([]);
  });

  it('says whether it is there, and reads it back as a stream', async () => {
    const stored = await store.put(workspace, bytes('Read me.\n'));
    expect(await store.has(workspace, stored.hash)).toBe(true);
    expect(await store.size(workspace, stored.hash)).toBe(9);

    const chunks: Buffer[] = [];
    for await (const chunk of store.read(workspace, stored.hash)) {
      chunks.push(chunk as Buffer);
    }
    expect(Buffer.concat(chunks).toString('utf8')).toBe('Read me.\n');
  });

  it('answers for a file that is not there rather than throwing', async () => {
    const absent = contentHash(bytes('Never uploaded.\n'));
    // The integrity check asks exactly this of every row, and an exception per
    // missing file would make the report the first missing file and nothing else.
    expect(await store.has(workspace, absent)).toBe(false);
    expect(await store.size(workspace, absent)).toBeNull();
  });

  it('keeps one workspace out of another', async () => {
    const other = 'ws_01J8Z3M4Q9V0X7K2B5N6P8R1T4';
    const stored = await store.put(workspace, bytes('One workspace only.\n'));
    expect(await store.has(other, stored.hash)).toBe(false);
  });

  it('removes what it was asked to, and does not complain twice', async () => {
    const stored = await store.put(workspace, bytes('Temporary.\n'));
    await store.remove(workspace, stored.hash);
    expect(await store.has(workspace, stored.hash)).toBe(false);
    await expect(store.remove(workspace, stored.hash)).resolves.toBeUndefined();
  });

  it('does not mistake a directory for a file', async () => {
    const hash = contentHash(bytes('Never written, only shadowed.\n'));
    // `stat` succeeds on a directory too, and answering "yes, it is here" for one
    // would make the integrity check pass on a workspace whose files are gone and
    // whose directories are not.
    await mkdir(store.path(workspace, hash), { recursive: true });
    expect(await store.has(workspace, hash)).toBe(false);
  });
});
