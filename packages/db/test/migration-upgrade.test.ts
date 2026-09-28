import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createDatabase,
  getMigrationStatus,
  runMigrations,
  type DatabaseHandle,
} from '../src/index.ts';

const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));

let container: StartedPostgreSqlContainer;

/**
 * The migrations folder as it looked at an earlier point.
 *
 * A copy with the later files and the later journal entries removed, so
 * `runMigrations` takes the real code path on it — the same hashes, the same
 * recorded timestamps — and a later run against the whole folder applies exactly
 * the remainder. Faking the bookkeeping instead would test the fake.
 */
async function folderAsOf(count: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'knoverge-migrations-'));
  await cp(migrationsFolder, dir, { recursive: true });
  const journalPath = join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
    entries: { idx: number; tag: string }[];
  };
  const kept = [...journal.entries].sort((a, b) => a.idx - b.idx).slice(0, count);
  const dropped = journal.entries.filter((entry) => !kept.includes(entry));
  for (const entry of dropped) await rm(join(dir, `${entry.tag}.sql`), { force: true });
  await writeFile(journalPath, JSON.stringify({ ...journal, entries: kept }, null, 2), 'utf8');
  return dir;
}

/** A database of its own, because an upgrade starts from a particular state. */
async function freshDatabase(name: string): Promise<DatabaseHandle> {
  const admin = createDatabase({ connectionString: container.getConnectionUri(), max: 1 });
  try {
    await admin.db.execute(sql.raw(`CREATE DATABASE "${name}"`));
  } finally {
    await admin.close();
  }
  const uri = new URL(container.getConnectionUri());
  uri.pathname = `/${name}`;
  const handle = createDatabase({ connectionString: uri.toString(), max: 2 });
  handle.pool.on('error', () => undefined);
  return handle;
}

/** One workspace, once the schema can hold one. Idempotent, so every step may ask. */
async function keepARow(handle: DatabaseHandle): Promise<void> {
  const present = await handle.db.execute<{ present: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'workspaces'
    ) AS present
  `);
  if (present.rows[0]?.present !== true) return;
  const now = new Date().toISOString();
  await handle.db.execute(sql`
    INSERT INTO workspaces (id, slug, name, default_language, created_at, updated_at)
    VALUES ('ws_01M3H4Z00000000000000000ST', 'stepped', 'Stepped', 'en', ${now}, ${now})
    ON CONFLICT (id) DO NOTHING
  `);
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
});

afterAll(async () => {
  await container?.stop();
});

/**
 * Upgrading an installation that already holds something.
 *
 * Applying every migration to an empty database says a fresh install works. It says
 * nothing about the case an operator actually meets: a database created at an
 * earlier version, with rows in it, taking the migrations that came later. A
 * migration that only works on an empty database — one that assumes a column a
 * later file adds, or rewrites data and does not survive the data being there —
 * passes the fresh test and fails the upgrade.
 */
describe('upgrading an installation', () => {
  it('applies what is left, and leaves what was there', async () => {
    const journal = JSON.parse(
      await readFile(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: unknown[] };
    const total = journal.entries.length;
    // Half way, so the second half is a real stretch of the history rather than
    // the last file on its own.
    const half = Math.floor(total / 2);
    const older = await folderAsOf(half);
    const handle = await freshDatabase('upgrade_drill');
    try {
      await runMigrations(handle.db, older);
      const midway = await getMigrationStatus(handle.db, migrationsFolder);
      expect(midway.applied).toBe(half);
      expect(midway.pending).toHaveLength(total - half);

      // Something in the database, because an upgrade with nothing in it is the
      // test that already exists.
      const now = new Date().toISOString();
      await handle.db.execute(sql`
        INSERT INTO workspaces (id, slug, name, default_language, created_at, updated_at)
        VALUES ('ws_01M3H4Z00000000000000000UP', 'kept', 'Kept', 'en', ${now}, ${now})
      `);

      const result = await runMigrations(handle.db, migrationsFolder);
      expect(result.after.pending).toEqual([]);
      expect(result.after.applied).toBe(total);

      // The row is still the row. A migration that rewrote or dropped it would be
      // an upgrade that cost an operator their workspace.
      const kept = await handle.db.execute<{ slug: string; name: string }>(
        sql`SELECT slug, name FROM workspaces WHERE id = 'ws_01M3H4Z00000000000000000UP'`,
      );
      expect(kept.rows).toEqual([{ slug: 'kept', name: 'Kept' }]);

      // And the schema the last migration was supposed to produce is there.
      const present = await handle.db.execute<{ table_name: string }>(sql`
        SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
      `);
      const tables = present.rows.map((row) => row.table_name);
      expect(tables).toContain('webhooks');
      expect(tables).toContain('summary_dependencies');
    } finally {
      await handle.close();
      await rm(older, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('applies one at a time, from nothing to everything', async () => {
    // Every intermediate state, not only the halfway one: a migration that breaks
    // on the state its immediate predecessor leaves is the ordinary way this goes
    // wrong, and only stepping through finds it.
    const journal = JSON.parse(
      await readFile(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: unknown[] };
    const total = journal.entries.length;
    const handle = await freshDatabase('upgrade_step');
    try {
      for (let count = 1; count <= total; count += 1) {
        const folder = await folderAsOf(count);
        try {
          const result = await runMigrations(handle.db, folder);
          expect(result.after.pending, `step ${count}`).toEqual([]);
          expect(result.after.applied, `step ${count}`).toBe(count);
          // A row from the moment there is somewhere to put one, carried through
          // every step after it. Stepping over an empty database would miss the
          // whole class this test exists for: a migration that works until the
          // table has something in it.
          await keepARow(handle);
        } finally {
          await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        }
      }
      expect((await getMigrationStatus(handle.db, migrationsFolder)).pending).toEqual([]);
    } finally {
      await handle.close();
    }
  });

  it('ignores a file edited after it was applied, which is why review is the guard', async () => {
    // The policy from v0.1.0 on is that a released migration is immutable, and it is
    // worth knowing what enforces it. Not the runner: applied migrations are matched
    // by the timestamp the journal gives them, so an edit to a file already applied
    // is passed over rather than reported. The guard is the review of the pull
    // request that would contain the edit. Pinned here so that a drizzle version
    // which starts refusing is noticed rather than discovered.
    const handle = await freshDatabase('upgrade_edited');
    const folder = await folderAsOf(3);
    try {
      await runMigrations(handle.db, folder);
      const journal = JSON.parse(await readFile(join(folder, 'meta', '_journal.json'), 'utf8')) as {
        entries: { tag: string }[];
      };
      const second = journal.entries[1] as { tag: string };
      const path = join(folder, `${second.tag}.sql`);
      await writeFile(path, `${await readFile(path, 'utf8')}\n-- edited after release\n`, 'utf8');
      const after = await runMigrations(handle.db, folder);
      expect(after.after.pending).toEqual([]);
    } finally {
      await handle.close();
      await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
