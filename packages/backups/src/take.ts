import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { backupName, isBackupName, takenAt } from './names.ts';
import type { BackupTools } from './tools.ts';

/**
 * What a backup needs to know about the installation it is copying.
 *
 * Narrow on purpose. This package takes the copy; who holds the write lock and
 * where the sequence comes from belong to whoever owns the database, which is
 * the server in one process and the command line in another.
 */
export interface BackupSource {
  /** Every workspace: the locks to take, and the manifest's own list. */
  workspaces(): Promise<readonly { id: string; slug: string }[]>;
  /** Where a workspace's ledger stands, for a restore to check against. */
  latestSequence(workspaceId: string): Promise<number>;
  /** Holds a workspace's write lock for as long as `fn` runs. */
  withWorkspaceLock<T>(workspaceId: string, fn: () => Promise<T>): Promise<T>;
}

export interface BackupOptions {
  /** Where the timestamped directory goes. */
  into: string;
  dataDir: string;
  /**
   * How long a copy on this machine is kept. Days rather than a count, because
   * days is what an operator means and a count only matches it while the
   * schedule is daily (ADR 0040).
   */
  retentionDays: number;
  now?: Date;
}

export interface BackupResult {
  path: string;
  name: string;
  workspaces: { workspace_id: string; slug: string; sequence: number }[];
  removed: string[];
}

/**
 * Every workspace's write lock, taken in one order and held for the whole
 * backup.
 *
 * This is what the application adds over a shell script. `pg_dump` and `tar`
 * run one after the other without stopping anything, so a write in flight lands
 * on one side of the backup and not the other. The skew is on the repairable
 * side — the archive may hold a commit the dump does not know about, which
 * recovery detects and resolves — but repairable is not the same as absent.
 * With every write lock held, no canonical write can start, so the dump and the
 * archive describe one moment.
 *
 * Sorted, because two backups at once would otherwise take the same locks in
 * different orders and wait for each other. A writer takes one workspace lock at
 * a time and cannot deadlock against this.
 */
async function withEveryWorkspaceLocked<T>(
  source: BackupSource,
  ids: readonly string[],
  fn: () => Promise<T>,
): Promise<T> {
  const [first, ...rest] = ids;
  if (first === undefined) return fn();
  return source.withWorkspaceLock(first, () => withEveryWorkspaceLocked(source, rest, fn));
}

/**
 * One consistent backup: the database, then the workspace repositories.
 *
 * The order is deliberate and costs nothing here, because nothing can write in
 * between: a dump taken first can only be missing a commit the archive holds,
 * which is the direction recovery can resolve.
 */
export async function takeBackup(
  source: BackupSource,
  options: BackupOptions,
  tools: BackupTools,
): Promise<BackupResult> {
  const workspaces = await source.workspaces();
  const ids = workspaces.map((w) => w.id).sort();
  const now = options.now ?? new Date();
  const name = backupName(now);
  const target = join(options.into, name);
  // Built beside the final name and moved into place at the end, so a run that
  // dies half way leaves nothing a restore could mistake for a whole backup, and
  // nothing rotation counts.
  const staging = `${target}.partial`;
  await mkdir(staging, { recursive: true });

  let heads: BackupResult['workspaces'] = [];
  try {
    await withEveryWorkspaceLocked(source, ids, async () => {
      // Read under the lock, so the numbers describe the same moment the dump and
      // the archive do. A restore can check that it got this far.
      heads = await Promise.all(
        workspaces.map(async (w) => ({
          workspace_id: w.id,
          slug: w.slug,
          sequence: await source.latestSequence(w.id),
        })),
      );
      await tools.dump(join(staging, 'postgres.dump'));
      await tools.archive(join(staging, 'data.tar.gz'), options.dataDir);
    });

    await writeFile(
      join(staging, 'manifest.txt'),
      [
        `taken_at=${name}`,
        'taken_by=knoverge backup',
        'order=postgres-then-data',
        'locked=every-workspace',
        `data_dir=${options.dataDir}`,
        ...heads.map((h) => `workspace=${h.workspace_id} slug=${h.slug} sequence=${h.sequence}`),
        '',
      ].join('\n'),
      'utf8',
    );
    await rename(staging, target);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }

  const removed = await rotate(options.into, options.retentionDays, now);
  return { path: target, name, workspaces: heads, removed };
}

/**
 * Removes the copies that are older than the window, and says which.
 *
 * Whole backups only, by their own names: a partial run cannot push a good one
 * out of the window, and a file somebody else left in the directory is not ours
 * to delete.
 *
 * The newest is never removed, however old it is. An installation whose
 * schedule has been broken for longer than the retention still has one copy
 * when it comes back, which is the difference between a window and a deadline.
 */
async function rotate(into: string, retentionDays: number, now: Date): Promise<string[]> {
  const whole = (await readdir(into, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && isBackupName(entry.name))
    .map((entry) => entry.name)
    .sort();
  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  const removed = whole
    .slice(0, Math.max(0, whole.length - 1))
    .filter((name) => takenAt(name).getTime() < cutoff);
  for (const old of removed) await rm(join(into, old), { recursive: true, force: true });
  return removed;
}
