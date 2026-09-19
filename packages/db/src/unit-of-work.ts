import type { Tx, UnitOfWork } from '@knoverge/core';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import type { NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';

import type { Database } from './client.ts';
import type * as schema from './schema/index.ts';

export type DrizzleTx = PgTransaction<
  NodePgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

/** Unwraps the opaque core transaction handle. Repositories only. */
export function asTx(tx: Tx): DrizzleTx {
  return tx as unknown as DrizzleTx;
}

export function createUnitOfWork(db: Database): UnitOfWork {
  return {
    run: (fn) => db.transaction((tx) => fn(tx as unknown as Tx)),
  };
}
