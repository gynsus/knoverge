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
let handle: DatabaseHandle;

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  handle = createDatabase({ connectionString: container.getConnectionUri(), max: 2 });
});

afterAll(async () => {
  await handle?.close();
  await container?.stop();
});

describe('migrations', () => {
  it('reports everything pending on an empty database', async () => {
    const status = await getMigrationStatus(handle.db, migrationsFolder);
    expect(status.applied).toBe(0);
    expect(status.total).toBeGreaterThan(0);
    expect(status.pending).toHaveLength(status.total);
  });

  it('applies all migrations and installs the required extensions', async () => {
    const result = await runMigrations(handle.db, migrationsFolder);
    expect(result.before.applied).toBe(0);
    expect(result.after.pending).toEqual([]);
    expect(result.after.applied).toBe(result.after.total);

    const ext = await handle.db.execute<{ extname: string }>(
      sql`SELECT extname FROM pg_extension WHERE extname IN ('vector', 'pg_trgm', 'unaccent') ORDER BY extname`,
    );
    expect(ext.rows.map((r) => r.extname)).toEqual(['pg_trgm', 'unaccent', 'vector']);
  });

  it('is idempotent', async () => {
    const result = await runMigrations(handle.db, migrationsFolder);
    expect(result.before.pending).toEqual([]);
    expect(result.after.applied).toBe(result.before.applied);
  });
});

describe('the invariants the schema now states', () => {
  it('installs them, so a bad value is refused by the database and not only by a type', async () => {
    const rows = await handle.db.execute(
      sql`SELECT conname FROM pg_constraint WHERE conname IN (
        'categories_parent_id_categories_id_fk',
        'categories_path_ends_with_slug',
        'actors_type_check',
        'agents_trust_tier_check',
        'categories_status_check',
        'workspace_memberships_role_check',
        'permission_grants_effect_check',
        'policy_rules_effect_check'
      )`,
    );
    // Until now these lived only in TypeScript, so a repository cast turned a
    // bad column value into a well-typed lie the domain believed.
    expect(rows.rows).toHaveLength(8);
  });

  it('refuses truncating the ledger', async () => {
    // The row trigger never saw a TRUNCATE, and the promise is about the table.
    await expect(handle.db.execute(sql`TRUNCATE events`)).rejects.toThrow();
    const trigger = await handle.db.execute(
      sql`SELECT tgname FROM pg_trigger WHERE tgrelid = 'events'::regclass AND tgname = 'events_no_truncate'`,
    );
    expect(trigger.rows).toHaveLength(1);
  });
});
