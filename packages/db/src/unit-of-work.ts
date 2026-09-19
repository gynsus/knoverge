import type { Tx, UnitOfWork } from '@knoverge/core';
import { sql } from 'drizzle-orm';
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
    runExclusive: (key, fn) =>
      db.transaction(async (tx) => {
        // Held until the transaction ends, so a second caller waits for the
        // first to commit and then sees its rows.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
        return fn(tx as unknown as Tx);
      }),
  };
}
