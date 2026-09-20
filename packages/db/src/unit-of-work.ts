import { DomainError, type Tx, type UnitOfWork } from '@knoverge/core';
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

/**
 * How long a write waits for the workspace lock before giving up.
 *
 * Generous, because the queue is other writes to the same workspace and each
 * is short; long enough that ordinary contention never surfaces, short enough
 * that a caller is not left hanging on a stuck one.
 */
const WORKSPACE_LOCK_TIMEOUT_MS = 30_000;

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
      // A connection of its own, held for the whole write, because the callback
      // opens its own transactions and commits to Git in between: a
      // transaction-scoped lock would be gone before the commit.
      //
      // The lock is tried rather than waited on, and a caller that does not get
      // it lets its connection go before sleeping. Waiting while holding one
      // deadlocks the pool as soon as there are more waiting writers than
      // connections: every connection is held by somebody waiting, and the one
      // writer that holds the lock cannot get a connection to do its work.
      const deadline = Date.now() + WORKSPACE_LOCK_TIMEOUT_MS;
      for (let attempt = 1; ; attempt += 1) {
        const gate = await db.$client.connect();
        const attempted = await gate.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock($1, hashtext($2)) AS locked',
          [LOCK_WORKSPACE_WRITE, workspaceId],
        );
        if (attempted.rows[0]?.locked === true) {
          try {
            // Not retried: the callback may have committed to Git, and a commit
            // cannot be undone by running the callback again.
            return await fn();
          } finally {
            await gate
              .query('SELECT pg_advisory_unlock($1, hashtext($2))', [
                LOCK_WORKSPACE_WRITE,
                workspaceId,
              ])
              .catch(() => undefined);
            gate.release();
          }
        }
        gate.release();
        if (Date.now() >= deadline) {
          throw new DomainError(
            'RATE_LIMITED',
            'another change to this workspace is still in progress; try again shortly',
            { objectIds: { workspace_id: workspaceId } },
          );
        }
        // Backs off, with jitter so several waiters do not wake together.
        const wait = Math.min(200, 5 * attempt) + Math.random() * 20;
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    },
  };
}
