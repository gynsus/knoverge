import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import * as schema from './schema/index.ts';

export type Database = NodePgDatabase<typeof schema>;

export interface DatabaseHandle {
  pool: Pool;
  db: Database;
  close(): Promise<void>;
}

export interface DatabaseOptions {
  connectionString: string;
  /** Maximum pooled connections. Defaults to 10. */
  max?: number;
}

export function createDatabase(options: DatabaseOptions): DatabaseHandle {
  const pool = new Pool({ connectionString: options.connectionString, max: options.max ?? 10 });
  const db = drizzle(pool, { schema, casing: 'snake_case' });
  return {
    pool,
    db,
    close: () => pool.end(),
  };
}
