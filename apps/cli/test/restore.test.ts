import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { takeBackup } from '@knoverge/backups';
import type { WorkspaceId } from '@knoverge/contracts';
import {
  createDatabase,
  createRepositories,
  createUnitOfWork,
  runMigrations,
  type DatabaseHandle,
} from '@knoverge/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { backupSource } from '../src/backup.ts';
import {
  SELF,
  inspectTarget,
  restoreBackup,
  restoredWell,
  type RestoreTools,
} from '../src/restore.ts';
import type { Services } from '../src/run.ts';

const run = promisify(execFile);
const migrationsFolder = fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url));

let container: StartedPostgreSqlContainer;
let handle: DatabaseHandle;
let services: Services;
let dataDir: string;
let into: string;
let workspaceId: WorkspaceId;

/**
 * A dump and a restore run by the database's own binaries.
 *
 * The same seam the backup uses, for the same reason: `pg_restore` has to match
 * the server, so a test that used the host's copy would pass or fail on the host.
 * The file is copied in and out so the bytes are the ones a real dump produced.
 */
const INSIDE = '/tmp/restore-test.dump';

function containerTools(): RestoreTools & { dumpInto: (file: string) => Promise<void> } {
  return {
    async dumpInto(file) {
      const dumped = await container.exec([
        'pg_dump',
        `--username=${container.getUsername()}`,
        `--dbname=${container.getDatabase()}`,
        '--format=custom',
        `--file=${INSIDE}`,
      ]);
      if (dumped.exitCode !== 0) throw new Error(`pg_dump exited ${dumped.exitCode}`);
      // Keeps the file inside the container for the restore, and writes a marker
      // out so the backup directory looks like one on disk.
      await writeFile(file, 'PGDMP', 'utf8');
    },
    async load(_file, replacing) {
      const result = await container.exec([
        'pg_restore',
        `--username=${container.getUsername()}`,
        `--dbname=${container.getDatabase()}`,
        ...(replacing ? ['--clean', '--if-exists'] : []),
        '--no-owner',
        '--no-privileges',
        INSIDE,
      ]);
      if (result.exitCode !== 0) throw new Error(`pg_restore exited ${result.exitCode}`);
    },
    async unpack(file, directory) {
      await run('tar', ['-xzf', file, '-C', directory]);
    },
  };
}

async function backupDirectory(now: Date): Promise<string> {
  const tools = containerTools();
  const result = await takeBackup(
    backupSource(services),
    { into, dataDir, retentionDays: 14, now },
    {
      dump: (file) => tools.dumpInto(file),
      archive: (file, directory) =>
        run('tar', ['-czf', file, '-C', directory, '.']).then(() => undefined),
    },
  );
  return result.path;
}

/**
 * A restore, once the database is quiet enough for the command to agree to run.
 *
 * The wait is here rather than at the end of the backup because the tests do
 * work in between — an insert, a file removed, a manifest rewritten — and a
 * database that was quiet before that is not the thing the command checks. CI
 * found this with one client connected that a wait two statements earlier had
 * not seen.
 */
async function restoreFrom(
  from: string,
  options: { force: boolean },
): Promise<Awaited<ReturnType<typeof restoreBackup>>> {
  await dumpDisconnected();
  return restoreBackup(handle.db, ok, { from, dataDir, force: options.force }, containerTools());
}

/**
 * Waits for the dump's own connection to go, and to stay gone.
 *
 * `pg_dump` runs inside the container, and while it does it is an ordinary
 * client backend on this database — which is exactly what a restore refuses to
 * start beside. Every test here takes a backup and restores it in the same
 * breath, so the dump that has just finished can still be in
 * `pg_stat_activity` when the restore looks, and the command refuses because
 * the test is holding the thing it warns about.
 *
 * One reading of zero is not enough, which CI showed after the first version of
 * this waited for exactly that: `container.exec` resolves around the dump
 * rather than strictly after its backend is registered and gone, so a single
 * look can fall in the gap before the connection appears and report a quiet
 * database that is about to be busy. Two readings with a gap between them
 * cannot both land there.
 *
 * The wait belongs here and not in the command. An operator's restore never
 * meets this, because nothing dumps while it runs; giving the check a grace
 * period would weaken the one guard that stops a restore fighting a live
 * server. So the test waits for the condition the command itself defines,
 * through the command's own function.
 */
async function dumpDisconnected(): Promise<void> {
  let quiet = 0;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const { others } = await inspectTarget(handle.db, dataDir);
    quiet = others.length === 0 ? quiet + 1 : 0;
    if (quiet >= 2) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('a client was still connected ten seconds after the dump');
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  // Named the way the command names its own, so the check for other clients
  // excludes this pool exactly as it excludes the real one.
  const mine = new URL(container.getConnectionUri());
  mine.searchParams.set('application_name', SELF);
  handle = createDatabase({ connectionString: mine.toString(), max: 6 });
  handle.pool.on('error', () => undefined);
  await runMigrations(handle.db, migrationsFolder);

  const repositories = createRepositories(handle.db);
  const uow = createUnitOfWork(handle.db);
  services = { repositories, uow } as unknown as Services;

  dataDir = await mkdtemp(join(tmpdir(), 'knoverge-restore-data-'));
  into = await mkdtemp(join(tmpdir(), 'knoverge-restore-out-'));
  await mkdir(join(dataDir, 'repositories'), { recursive: true });
  await writeFile(join(dataDir, 'repositories', 'README.md'), '# canonical\n', 'utf8');

  workspaceId = 'ws_01M3H4Z00000000000000000RS' as WorkspaceId;
  const now = new Date('2026-09-20T00:00:00Z');
  await uow.run((tx) =>
    repositories.workspaces.insert(tx, {
      id: workspaceId,
      slug: 'personal',
      name: 'Personal',
      description: null,
      defaultLanguage: 'en',
      settings: {},
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    }),
  );
});

afterAll(async () => {
  await handle?.close().catch(() => undefined);
  await container?.stop();
  for (const dir of [dataDir, into])
    if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const ok = async () => ({ ok: true, count: 0 });

describe('knoverge restore', () => {
  it('refuses a directory that is not a whole backup', async () => {
    const half = join(into, 'not-a-backup');
    await mkdir(half, { recursive: true });
    await writeFile(join(half, 'postgres.dump'), 'PGDMP', 'utf8');
    await expect(
      restoreBackup(handle.db, ok, { from: half, dataDir, force: false }, containerTools()),
    ).rejects.toThrow(/no data.tar.gz/u);
  });

  it('refuses a database that already holds knowledge unless told to replace it', async () => {
    const from = await backupDirectory(new Date('2026-09-27T10:00:00Z'));
    // The database still holds the workspace the backup was taken from, which is
    // the shape of the accident this guards: a restore aimed at a live
    // installation.
    await expect(restoreFrom(from, { force: false })).rejects.toThrow(
      /already holds 1 workspace\(s\): personal/u,
    );
  });

  it('puts it back, and says where each workspace came back to', async () => {
    const from = await backupDirectory(new Date('2026-09-27T11:00:00Z'));
    // Something the backup did not have, so the restore has to remove it.
    await handle.db.execute(sql`
      INSERT INTO workspaces (id, slug, name, default_language, created_at, updated_at)
      VALUES ('ws_01M3H4Z00000000000000000ZZ', 'later', 'Later', 'en', now(), now())
    `);
    await rm(join(dataDir, 'repositories', 'README.md'));

    const result = await restoreFrom(from, { force: true });

    expect(result.manifest.takenAt).toBe('20260927T110000Z');
    expect(result.replaced.map((w) => w.slug).sort()).toEqual(['later', 'personal']);
    expect(result.checks).toEqual([
      { workspaceId, slug: 'personal', expected: 0, actual: 0, ledger: 'ok' },
    ]);
    expect(restoredWell(result)).toBe(true);
    // The workspace the backup never had is gone, and the file it did have is
    // back.
    const rows = await handle.db.execute<{ slug: string }>(sql`SELECT slug FROM workspaces`);
    expect(rows.rows.map((r) => r.slug)).toEqual(['personal']);
    expect(await readdir(join(dataDir, 'repositories'))).toContain('README.md');
  });

  it('says so when a workspace did not come back where the backup left it', async () => {
    const from = await backupDirectory(new Date('2026-09-27T12:00:00Z'));
    // A manifest that claims more than the dump holds: the sequence check is what
    // notices, and a restore nobody checked is a restore nobody can trust.
    const manifest = await readFile(join(from, 'manifest.txt'), 'utf8');
    await writeFile(
      join(from, 'manifest.txt'),
      manifest.replace('sequence=0', 'sequence=42'),
      'utf8',
    );

    const result = await restoreFrom(from, { force: true });
    expect(result.checks[0]).toMatchObject({ expected: 42, actual: 0, ledger: 'ok' });
    expect(restoredWell(result)).toBe(false);
  });

  it('refuses while something else is connected to the database', async () => {
    const from = await backupDirectory(new Date('2026-09-27T13:00:00Z'));
    // "Stop application writes" is step one of the procedure, and a server
    // holding connections would fight the restore half way through it.
    const theirs = new URL(container.getConnectionUri());
    theirs.searchParams.set('application_name', 'knoverge-server');
    const other = createDatabase({ connectionString: theirs.toString(), max: 1 });
    other.pool.on('error', () => undefined);
    try {
      await other.db.execute(sql`SELECT 1`);
      await expect(
        restoreBackup(handle.db, ok, { from, dataDir, force: true }, containerTools()),
      ).rejects.toThrow(
        // Named. "Stop the application first" is not an instruction for
        // somebody who has already stopped it, and then finding what is still
        // holding the database is theirs to do with no help from the command
        // that noticed.
        /1 other client\(s\) are connected to this database \(knoverge-server \(idle\)\); stop the application first/u,
      );
    } finally {
      await other.close();
    }
  });
});
