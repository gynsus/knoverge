import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { WorkspaceId } from '@knoverge/contracts';
import {
  createDatabase,
  createRepositories,
  createUnitOfWork,
  runMigrations,
  type DatabaseHandle,
} from '@knoverge/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { takeBackup, type BackupTools } from '../src/backup.ts';
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

describe('knoverge backup', () => {
  it('writes a whole backup, or nothing that looks like one', async () => {
    const tools = containerTools();
    let midRun: string[] = [];
    const result = await takeBackup(
      services,
      { into, dataDir, keep: 14, now: new Date('2026-09-27T10:00:00Z') },
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

  it('dumps the database before it archives the repositories', async () => {
    // The order the deployment guide gives, and the reason is asymmetric: a
    // database ahead of the archive is a revision with no commit, which nothing
    // can repair.
    const order: string[] = [];
    await takeBackup(
      services,
      { into, dataDir, keep: 14, now: new Date('2026-09-27T11:00:00Z') },
      {
        dump: async (file) => {
          order.push('dump');
          await writeFile(file, 'PGDMP-not-really', 'utf8');
        },
        archive: async (file) => {
          order.push('archive');
          await writeFile(file, 'tar-not-really', 'utf8');
        },
      },
    );
    expect(order).toEqual(['dump', 'archive']);
  });

  it('holds every workspace write lock while it runs', async () => {
    // The whole point of the command: `infra/backup/backup.sh` cannot do this,
    // so a write in flight lands on one side of its backup and not the other.
    let waiting: Promise<string> | undefined;
    let outcome: string | undefined;
    await takeBackup(
      services,
      { into, dataDir, keep: 14, now: new Date('2026-09-27T12:00:00Z') },
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

  it('leaves nothing behind when the dump fails', async () => {
    const before = await readdir(into);
    await expect(
      takeBackup(
        services,
        { into, dataDir, keep: 14, now: new Date('2026-09-27T13:00:00Z') },
        {
          dump: async () => {
            throw new Error('pg_dump: connection refused');
          },
          archive: async (file) => writeFile(file, '', 'utf8'),
        },
      ),
    ).rejects.toThrow(/connection refused/u);
    // Not even the staging directory: a half-written backup is worse than none,
    // because somebody restores from it.
    expect((await readdir(into)).sort()).toEqual(before.sort());
  });

  it('keeps the last few and removes the rest, counting only whole ones', async () => {
    const older = ['20260101T000000Z', '20260102T000000Z', '20260103T000000Z'];
    for (const name of older) await mkdir(join(into, name), { recursive: true });
    // A run that died: rotation must not count it, or a partial backup could push
    // a good one out of the window.
    await mkdir(join(into, '20260104T000000Z.partial'), { recursive: true });

    const result = await takeBackup(
      services,
      { into, dataDir, keep: 2, now: new Date('2026-09-27T14:00:00Z') },
      {
        dump: async (file) => writeFile(file, 'PGDMP-not-really', 'utf8'),
        archive: async (file) => writeFile(file, 'tar-not-really', 'utf8'),
      },
    );
    const left = (await readdir(into)).filter((name) => /^\d{8}T\d{6}Z$/u.test(name)).sort();
    // The newest two, and this run is one of them.
    expect(left).toHaveLength(2);
    expect(left).toContain('20260927T140000Z');
    expect(result.removed).toContain('20260101T000000Z');
    expect(await readdir(join(into, '20260104T000000Z.partial'))).toEqual([]);
  });
});
