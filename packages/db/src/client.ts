import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import * as schema from './schema/index.ts';

/**
 * The Drizzle instance, including the pool it was built on. Drizzle exposes the
 * pool as `$client` but leaves it off the generic type, and the migration
 * runner needs a connection of its own to hold its lock.
 */
export type Database = NodePgDatabase<typeof schema> & { $client: Pool };

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

/**
 * How long a caller waits for a pooled connection.
 *
 * Without it `pool.connect()` waits forever, which turns any transient
 * exhaustion into a process that never answers again rather than a request
 * that fails and frees what it held.
 */
const CONNECTION_TIMEOUT_MS = 10_000;

/**
 * How long one statement may run.
 *
 * Every query in this application is a small indexed one. A statement that
 * takes ten seconds is a statement that has gone wrong, and it is holding a
 * connection the rest of the process needs.
 */
const STATEMENT_TIMEOUT_MS = 10_000;

/**
 * How long a transaction may sit idle.
 *
 * A transaction nobody is driving holds its locks and its snapshot. This is the
 * backstop for a client that died between statements without its connection
 * noticing.
 */
const IDLE_IN_TRANSACTION_TIMEOUT_MS = 30_000;

export function createDatabase(options: DatabaseOptions): DatabaseHandle {
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    idle_in_transaction_session_timeout: IDLE_IN_TRANSACTION_TIMEOUT_MS,
    // A connection to a database that has gone away is detected in minutes
    // rather than in PostgreSQL's two-hour default, which is how long a
    // workspace lock held by a killed process would otherwise survive.
    keepAlive: true,
    keepAliveInitialDelayMillis: 30_000,
  });
  const db = drizzle(pool, { schema, casing: 'snake_case' });
  return {
    pool,
    db,
    close: () => pool.end(),
  };
}
