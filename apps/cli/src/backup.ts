import { execFile } from 'node:child_process';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { Services } from './run.ts';

const run = promisify(execFile);

/**
 * The two external programs a backup needs, as a seam.
 *
 * Not for its own sake: `pg_dump` has to match the server's major version, so a
 * test that shelled out to whatever is on the machine running it would pass or
 * fail on the machine rather than on the code. The default is the real pair, and
 * a test can hand in a pair that runs `pg_dump` inside the database container —
 * which is a real dump of a real database, just not one that depends on the host.
 */
export interface BackupTools {
  /** A custom-format dump of the whole database, at `file`. */
  dump(file: string): Promise<void>;
  /** A gzipped archive of `directory`, at `file`. */
  archive(file: string, directory: string): Promise<void>;
}

/** `pg_dump` and `tar`, with the password kept out of the process list. */
export function systemTools(databaseUrl: string): BackupTools {
  const parsed = new URL(databaseUrl);
  const args = [
    `--host=${parsed.hostname}`,
    `--port=${parsed.port || '5432'}`,
    `--username=${decodeURIComponent(parsed.username)}`,
    `--dbname=${parsed.pathname.replace(/^\//u, '')}`,
  ];
  // Never as an argument: `ps` shows every process's command line to everyone on
  // the machine, and a connection string carries the password.
  const env = { ...process.env, PGPASSWORD: decodeURIComponent(parsed.password) };
  return {
    async dump(file) {
      await run('pg_dump', [...args, '--format=custom', `--file=${file}`], { env });
    },
    async archive(file, directory) {
      // Short flags: the runtime image is Alpine, and busybox tar does not take
      // the long ones the compose backup script uses on Debian.
      await run('tar', ['-czf', file, '-C', directory, '.']);
    },
  };
}

export interface BackupOptions {
  /** Where the timestamped directory goes. */
  into: string;
  dataDir: string;
  /** How many whole backups to keep, oldest removed first. */
  keep: number;
  now?: Date;
}

export interface BackupResult {
  path: string;
  workspaces: { workspace_id: string; slug: string; sequence: number }[];
  removed: string[];
}

/** UTC to the second, which sorts in the order the backups were taken. */
function stamp(now: Date): string {
  return `${now.toISOString().replace(/[-:]/gu, '').split('.')[0]}Z`;
}

/**
 * Every workspace's write lock, taken in one order and held for the whole
 * backup.
 *
 * This is what the command adds. `infra/backup/backup.sh` dumps the database and
 * archives the repositories without stopping anything, so a write in flight lands
 * on one side of the backup and not the other. The script pushes that skew onto
 * the repairable side deliberately — the archive may hold a commit the dump does
 * not know about, which recovery detects and resolves — but repairable is not the
 * same as absent. With every write lock held, no canonical write can start, so the
 * dump and the archive describe one moment.
 *
 * Sorted, because two backups at once would otherwise take the same locks in
 * different orders and wait for each other. A writer takes one workspace lock at
 * a time and cannot deadlock against this.
 */
async function withEveryWorkspaceLocked<T>(
  services: Services,
  ids: readonly string[],
  fn: () => Promise<T>,
): Promise<T> {
  const [first, ...rest] = ids;
  if (first === undefined) return fn();
  return services.uow.withWorkspaceLock(first, () => withEveryWorkspaceLocked(services, rest, fn));
}

/**
 * One consistent backup: the database, then the workspace repositories.
 *
 * The order is the script's, for the reason the script documents, and it costs
 * nothing here because nothing can write in between.
 */
export async function takeBackup(
  services: Services,
  options: BackupOptions,
  tools: BackupTools,
): Promise<BackupResult> {
  const workspaces = await services.repositories.workspaces.list();
  const ids = workspaces.map((w) => w.id).sort();
  const at = stamp(options.now ?? new Date());
  const target = join(options.into, at);
  // Built beside the final name and moved into place at the end, so a run that
  // dies half way leaves nothing a restore could mistake for a whole backup, and
  // nothing rotation counts.
  const staging = `${target}.partial`;
  await mkdir(staging, { recursive: true });

  let heads: BackupResult['workspaces'] = [];
  try {
    await withEveryWorkspaceLocked(services, ids, async () => {
      // Read under the lock, so the numbers describe the same moment the dump and
      // the archive do. A restore can check that it got this far.
      heads = await Promise.all(
        workspaces.map(async (w) => ({
          workspace_id: w.id as string,
          slug: w.slug,
          sequence: await services.repositories.events.latestSequence(w.id),
        })),
      );
      await tools.dump(join(staging, 'postgres.dump'));
      await tools.archive(join(staging, 'data.tar.gz'), options.dataDir);
    });

    await writeFile(
      join(staging, 'manifest.txt'),
      [
        `taken_at=${at}`,
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

  // Rotation counts whole backups only, so a partial run cannot push a good one
  // out of the window.
  const whole = (await readdir(options.into, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^\d{8}T\d{6}Z$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const removed = whole.slice(0, Math.max(0, whole.length - options.keep));
  for (const old of removed) await rm(join(options.into, old), { recursive: true, force: true });

  return { path: target, workspaces: heads, removed };
}
