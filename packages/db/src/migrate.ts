import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

import type { Database } from './client.ts';
import { LOCK_MIGRATIONS } from './locks.ts';

export const MIGRATIONS_TABLE = '__drizzle_migrations';
export const MIGRATIONS_SCHEMA = 'drizzle';

/**
 * Resolves the migrations directory shipped with this package. Works from source,
 * from a bundled server (the package stays in node_modules) and inside the image.
 */
export function defaultMigrationsFolder(): string {
  const journal = fileURLToPath(import.meta.resolve('@knoverge/db/migrations/meta/_journal.json'));
  return dirname(dirname(journal));
}

interface Journal {
  entries: { idx: number; tag: string; when: number }[];
}

export interface MigrationStatus {
  /** Migrations listed in the journal. */
  total: number;
  /** Migrations recorded as applied in the database. */
  applied: number;
  /** Journal tags not yet applied, in order. */
  pending: string[];
}

export async function getMigrationStatus(
  db: Database,
  migrationsFolder: string,
): Promise<MigrationStatus> {
  const journal = JSON.parse(
    await readFile(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
  ) as Journal;
  const entries = [...journal.entries].sort((a, b) => a.idx - b.idx);

  const exists = await db.execute<{ present: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = ${MIGRATIONS_SCHEMA} AND table_name = ${MIGRATIONS_TABLE}
    ) AS present
  `);
  if (!exists.rows[0]?.present) {
    return { total: entries.length, applied: 0, pending: entries.map((e) => e.tag) };
  }

  const rows = await db.execute<{ created_at: string }>(
    sql.raw(
      `SELECT created_at FROM "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}" ORDER BY created_at ASC`,
    ),
  );
  // Drizzle records the journal "when" timestamp of each applied migration.
  const appliedWhen = new Set(rows.rows.map((r) => Number(r.created_at)));
  const pending = entries.filter((e) => !appliedWhen.has(e.when)).map((e) => e.tag);
  return { total: entries.length, applied: entries.length - pending.length, pending };
}

export interface RunMigrationsResult {
  before: MigrationStatus;
  after: MigrationStatus;
}

/**
 * Applies pending migrations.
 *
 * Safe to call concurrently across processes. Nothing in the migration runner
 * itself serialises two processes that both find the same migration pending, so
 * this holds an advisory lock for the whole run: the second process waits and
 * then finds nothing left to apply. That is what lets a `web` and a `worker`
 * container start together without coordinating.
 *
 * The lock is held on a connection of its own, so the pool needs at least two.
 */
export async function runMigrations(
  db: Database,
  migrationsFolder: string,
): Promise<RunMigrationsResult> {
  const gate = await db.$client.connect();
  try {
    await gate.query('BEGIN');
    await gate.query('SELECT pg_advisory_xact_lock($1, $2)', [LOCK_MIGRATIONS, 0]);
    const before = await getMigrationStatus(db, migrationsFolder);
    await migrate(db, {
      migrationsFolder,
      migrationsSchema: MIGRATIONS_SCHEMA,
      migrationsTable: MIGRATIONS_TABLE,
    });
    const after = await getMigrationStatus(db, migrationsFolder);
    await gate.query('COMMIT');
    return { before, after };
  } catch (error) {
    await gate.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    gate.release();
  }
}
