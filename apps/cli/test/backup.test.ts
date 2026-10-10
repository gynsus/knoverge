import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { takeBackup, type BackupTools } from '@knoverge/backups';
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
 * A real `pg_dump`, run inside the database's own container.
 *
 * The tools are a seam for exactly this: `pg_dump` has to match the server's
 * major version, so shelling out to whatever is on the machine running the tests
 * would make them pass or fail on the machine. This dumps a real database with
 * the matching binary and copies the file out.
 */
function containerTools(): BackupTools {
  return {
    async dump(file) {
      const inside = '/tmp/backup-test.dump';
      const result = await container.exec([
        'pg_dump',
        `--username=${container.getUsername()}`,
        `--dbname=${container.getDatabase()}`,
        '--format=custom',
        `--file=${inside}`,
      ]);
      if (result.exitCode !== 0) throw new Error(`pg_dump exited ${result.exitCode}`);
      const copied = await container.copyArchiveFromContainer(inside);
      const chunks: Buffer[] = [];
      for await (const chunk of copied) chunks.push(Buffer.from(chunk as Buffer));
      // A tar stream of one file; what matters here is that the bytes came from
      // a real dump, not the packaging.
      await writeFile(file, Buffer.concat(chunks));
    },
    async archive(file, directory) {
      await run('tar', ['-czf', file, '-C', directory, '.']);
    },
  };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  handle = createDatabase({ connectionString: container.getConnectionUri(), max: 6 });
  handle.pool.on('error', () => undefined);
  await runMigrations(handle.db, migrationsFolder);

  const repositories = createRepositories(handle.db);
  const uow = createUnitOfWork(handle.db);
  // Only the two things a backup reads. The command's own composition root builds
  // the rest lazily, and none of it is involved.
  services = { repositories, uow } as unknown as Services;

  dataDir = await mkdtemp(join(tmpdir(), 'knoverge-backup-data-'));
  into = await mkdtemp(join(tmpdir(), 'knoverge-backup-out-'));
  await mkdir(join(dataDir, 'repositories'), { recursive: true });
  await writeFile(join(dataDir, 'repositories', 'README.md'), '# canonical\n', 'utf8');

  workspaceId = 'ws_01M3H4Z00000000000000000BK' as WorkspaceId;
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

/**
 * What only a real database can say.
 *
 * The order of the steps, the staging rename and rotation are the backup
 * package's own tests, which need no container. What is here is a real
 * `pg_dump` against a matching server and a real advisory lock with a second
 * connection waiting on it — neither of which a stub can be wrong about
 * convincingly.
 */
describe('knoverge backup', () => {
  it('writes a whole backup, or nothing that looks like one', async () => {
    const tools = containerTools();
    let midRun: string[] = [];
    const result = await takeBackup(
      backupSource(services),
      { into, dataDir, retentionDays: 14, now: new Date('2026-09-27T10:00:00Z') },
      {
        dump: async (file) => {
          // What is on disk while the backup is being taken. A run killed here
          // leaves this behind, so it must not be named like a finished backup —
          // and it is a restore that would find out otherwise.
          midRun = await readdir(into);
          await tools.dump(file);
        },
        archive: tools.archive,
      },
    );

    expect(midRun).toContain('20260927T100000Z.partial');
    expect(midRun).not.toContain('20260927T100000Z');

    expect(result.path).toBe(join(into, '20260927T100000Z'));
    const written = (await readdir(result.path)).sort();
    expect(written).toEqual(['data.tar.gz', 'manifest.txt', 'postgres.dump']);
    // Nothing left beside it: a `.partial` directory is what a run that died
    // leaves, and a restore must not be able to mistake one for a backup.
    expect((await readdir(into)).filter((name) => name.endsWith('.partial'))).toEqual([]);

    // The dump is a real one: custom-format files start with "PGDMP".
    const dump = await readFile(join(result.path, 'postgres.dump'));
    expect(dump.includes(Buffer.from('PGDMP'))).toBe(true);

    const manifest = await readFile(join(result.path, 'manifest.txt'), 'utf8');
    expect(manifest).toContain('order=postgres-then-data');
    expect(manifest).toContain('locked=every-workspace');
    // Where each workspace's ledger stood when the backup was taken, read under
    // the lock — so a restore can check it came back to the same place.
    expect(manifest).toContain(`workspace=${workspaceId} slug=personal sequence=0`);
  });

  it('holds every workspace write lock while it runs', async () => {
    // The whole point of the command: `infra/backup/backup.sh` cannot do this,
    // so a write in flight lands on one side of its backup and not the other.
    let waiting: Promise<string> | undefined;
    let outcome: string | undefined;
    await takeBackup(
      backupSource(services),
      { into, dataDir, retentionDays: 14, now: new Date('2026-09-27T12:00:00Z') },
      {
        dump: async (file) => {
          // A writer of the same workspace, from a connection of its own. Not
          // waited out: the server bounds the wait at thirty seconds, and a test
          // that sat through it would be measuring the timeout rather than the
          // lock.
          waiting = services.uow.withWorkspaceLock(workspaceId, async () => 'took it');
          outcome = await Promise.race([
            waiting,
            new Promise<string>((resolve) => setTimeout(() => resolve('still waiting'), 300)),
          ]);
          await writeFile(file, 'PGDMP-not-really', 'utf8');
        },
        archive: async (file) => writeFile(file, 'tar-not-really', 'utf8'),
      },
    );
    expect(outcome).toBe('still waiting');
    // And it goes through once the backup lets go, which is what makes this a
    // pause rather than a refusal.
    expect(await waiting).toBe('took it');
  });
});
