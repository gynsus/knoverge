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
