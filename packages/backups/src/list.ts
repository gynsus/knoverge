import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { isBackupName, takenAt } from './names.ts';

/** One whole copy on this machine, as a screen would list it. */
export interface StoredBackup {
  name: string;
  takenAt: Date;
  /** The three files together, which is what an operator is watching. */
  sizeBytes: number;
}

/**
 * What is on disk, newest first.
 *
 * A directory that does not exist is not an error: an installation that has
 * never taken a copy has nothing there, and the screen that asks is the one
 * that says so.
 */
export async function listBackups(into: string): Promise<StoredBackup[]> {
  let entries;
  try {
    entries = await readdir(into, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const found = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && isBackupName(entry.name))
      .map(async (entry) => ({
        name: entry.name,
        takenAt: takenAt(entry.name),
        sizeBytes: await sizeOf(join(into, entry.name)),
      })),
  );
  return found.sort((a, b) => b.name.localeCompare(a.name));
}

/**
 * The files directly inside one backup.
 *
 * Not recursive, because a backup holds three files and no directories. A file
 * that disappeared between the listing and the measurement counts as nothing
 * rather than failing the whole page: rotation runs while somebody is looking.
 */
async function sizeOf(directory: string): Promise<number> {
  const files = await readdir(directory, { withFileTypes: true });
  const sizes = await Promise.all(
    files
      .filter((file) => file.isFile())
      .map(async (file) => {
        try {
          return (await stat(join(directory, file.name))).size;
        } catch {
          return 0;
        }
      }),
  );
  return sizes.reduce((total, size) => total + size, 0);
}
