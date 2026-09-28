import { createHash } from 'node:crypto';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';

/** What a file turned out to be once it was written down. */
export interface StoredFile {
  /** `sha256:<hex>` of the bytes. */
  hash: string;
  size: number;
  /** False when the same bytes were already here, which is the ordinary case. */
  created: boolean;
}

/** The hash a file is kept under, in the form the rest of this product writes one. */
export function contentHash(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** The hex half, which is what a filename can be. */
function hex(hash: string): string {
  return hash.startsWith('sha256:') ? hash.slice('sha256:'.length) : hash;
}

/**
 * Files kept by the hash of their contents, beside the repositories and outside Git.
 *
 * `KNOVERGE_DATA_DIR/attachments/<workspace id>/<sha256>`: one directory per kind
 * of thing with the workspace under it, the way `repositories/<workspace id>`
 * already works (ADR 0008). Binary files do not belong in a repository whose
 * point is that a person can read it, and they are still inside the backup
 * boundary because the backup copies the data directory.
 *
 * Content-addressed, so the same file arriving twice is one file. That is what
 * makes a second upload cheap, and it is also why nothing here ever overwrites:
 * a path that exists already holds exactly the bytes being written.
 */
export class FileAttachmentStore {
  constructor(private readonly dataDir: string) {}

  /** Where a workspace's files live. Not a path any caller has to build itself. */
  directory(workspaceId: string): string {
    return join(this.dataDir, 'attachments', workspaceId);
  }

  path(workspaceId: string, hash: string): string {
    return join(this.directory(workspaceId), hex(hash));
  }

  /**
   * Writes the bytes and says what they were.
   *
   * Through a temporary name and a rename, which is atomic on one filesystem: a
   * process killed halfway through leaves a file nobody will read under a name
   * nobody will ask for, rather than a short file under the hash of a long one.
   */
  async put(workspaceId: string, bytes: Uint8Array): Promise<StoredFile> {
    const hash = contentHash(bytes);
    const destination = this.path(workspaceId, hash);
    if (await this.has(workspaceId, hash)) {
      return { hash, size: bytes.byteLength, created: false };
    }
    await mkdir(this.directory(workspaceId), { recursive: true });
    const staging = `${destination}.${process.pid}.${Date.now()}.part`;
    await writeFile(staging, bytes, { flag: 'wx' });
    try {
      await rename(staging, destination);
    } catch (err) {
      await rm(staging, { force: true });
      throw err;
    }
    return { hash, size: bytes.byteLength, created: true };
  }

  async has(workspaceId: string, hash: string): Promise<boolean> {
    try {
      const info = await stat(this.path(workspaceId, hash));
      return info.isFile();
    } catch {
      return false;
    }
  }

  /** The size on disk, or null when the file is not there. */
  async size(workspaceId: string, hash: string): Promise<number | null> {
    try {
      return (await stat(this.path(workspaceId, hash))).size;
    } catch {
      return null;
    }
  }

  /**
   * The file, as a stream.
   *
   * A stream rather than a buffer because a caller is usually a response: an
   * installation should be able to serve a hundred-megabyte file without holding
   * one in memory per reader.
   */
  read(workspaceId: string, hash: string): Readable {
    return createReadStream(this.path(workspaceId, hash));
  }

  /** Removes it. Used by nothing in the domain yet; a store has to be able to. */
  async remove(workspaceId: string, hash: string): Promise<void> {
    await rm(this.path(workspaceId, hash), { force: true });
  }
}
