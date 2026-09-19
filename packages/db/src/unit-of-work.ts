import type { Tx, UnitOfWork } from '@knoverge/core';
import { sql } from 'drizzle-orm';

import { LOCK_NAMED, LOCK_WORKSPACE_WRITE } from './locks.ts';
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

/** Serialisation failure and deadlock: PostgreSQL asks the client to retry. */
const RETRYABLE = new Set(['40001', '40P01']);
const MAX_ATTEMPTS = 3;

function isRetryable(err: unknown): boolean {
  const cause = err && typeof err === 'object' ? ((err as { cause?: unknown }).cause ?? err) : err;
  const code = (cause as { code?: string } | null)?.code;
  return code !== undefined && RETRYABLE.has(code);
}

async function withRetry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS || !isRetryable(err)) throw err;
      // Short, jittered backoff: the competing transaction usually finishes at once.
      await new Promise((resolve) => setTimeout(resolve, attempt * 10 + Math.random() * 10));
    }
  }
}

/**
 * Lock order, to be kept by every transaction that takes more than one:
 *
 *   1. the workspace write lock, held across a whole canonical write
 *   2. named locks from runExclusive (for example first-run setup)
 *   3. the taxonomy version lock of a workspace
 *   4. the event ledger lock of a workspace
 *
 * Taking them in another order can deadlock two transactions against each other.
 * A deadlock or serialisation failure is retried a few times before it reaches
 * the caller, so ordinary contention does not surface as an internal error.
 */
export function createUnitOfWork(db: Database): UnitOfWork {
  return {
    run: (fn) => withRetry(() => db.transaction((tx) => fn(tx as unknown as Tx))),
    runExclusive: (key, fn) =>
      withRetry(() =>
        db.transaction(async (tx) => {
          // Held until the transaction ends, so a second caller waits for the
          // first to commit and then sees its rows.
          await tx.execute(sql`SELECT pg_advisory_xact_lock(${LOCK_NAMED}, hashtext(${key}))`);
          return fn(tx as unknown as Tx);
        }),
      ),
    async withWorkspaceLock(workspaceId, fn) {
      // A connection of its own, held for the whole write. The callback opens
      // its own transactions on other connections and commits to Git in
      // between, so a transaction-scoped lock would be gone before the commit.
      // Not retried: the callback may have committed to Git, and a commit
      // cannot be undone by running the callback again.
      const gate = await db.$client.connect();
      try {
        await gate.query('SELECT pg_advisory_lock($1, hashtext($2))', [
          LOCK_WORKSPACE_WRITE,
          workspaceId,
        ]);
        try {
          return await fn();
        } finally {
          await gate
            .query('SELECT pg_advisory_unlock($1, hashtext($2))', [
              LOCK_WORKSPACE_WRITE,
              workspaceId,
            ])
            .catch(() => undefined);
        }
      } finally {
        gate.release();
      }
    },
  };
}
