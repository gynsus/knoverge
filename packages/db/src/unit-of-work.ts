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

/**
 * Serialises writes to one workspace inside this process before any connection
 * is taken.
 *
 * A canonical write needs two connections at its peak: the one holding the lock
 * for the whole write, and one for each transaction it opens in between. If
 * waiting writers each held a connection, enough of them would take every
 * connection in the pool and the one writer holding the lock could not open the
 * transaction that would let it finish — a deadlock with no timeout, because
 * `pool.connect()` waits forever by default.
 *
 * Queueing in memory first means a waiter costs nothing but a promise. The
 * advisory lock behind it is still what makes the exclusion real, because a
 * second process shares no memory with this one.
 */
class WorkspaceQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    // Never rejects, so one failed write does not cancel the queue behind it.
    const mine = previous.then(fn, fn);
    const tail = mine.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      // Only if nobody queued behind us, or the map grows one entry per
      // workspace that was ever written to.
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return mine;
  }
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
  const queue = new WorkspaceQueue();
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
    withWorkspaceLock(workspaceId, fn) {
      // In-process first, so that at most one call per workspace ever holds a
      // connection while waiting, and then the advisory lock for the writers
      // this process cannot see.
      return queue.run(workspaceId, async () => {
        // A connection of its own, held for the whole write, because the
        // callback opens its own transactions and commits to Git in between: a
        // transaction-scoped lock would be gone before the commit.
        const gate = await db.$client.connect().catch(() => {
          throw new DomainError('RATE_LIMITED', 'the server is busy; try again shortly', {
            objectIds: { workspace_id: workspaceId },
          });
        });
        try {
          // The wait is bounded by the server, so it is bounded even if this
          // process stops paying attention. A lock held by a backend whose
          // client is gone answers here rather than hanging.
          await gate.query(`SET lock_timeout = ${WORKSPACE_LOCK_TIMEOUT_MS}`);
          await gate.query('SELECT pg_advisory_lock($1, hashtext($2))', [
            LOCK_WORKSPACE_WRITE,
            workspaceId,
          ]);
        } catch (error) {
          gate.release();
          throw new DomainError(
            'RATE_LIMITED',
            'another change to this workspace is still in progress; try again shortly',
            { objectIds: { workspace_id: workspaceId }, cause: error },
          );
        }
        try {
          // Not retried: the callback may have committed to Git, and a commit
          // cannot be undone by running the callback again.
          return await fn();
        } finally {
          // A session-scoped lock outlives the query that took it, and a pooled
          // connection is not a session that ends. If the unlock did not
          // report success the connection is destroyed rather than returned,
          // because returning it would leave the workspace locked until the
          // pool happened to recycle that client, which it does not do.
          const released = await gate
            .query<{ ok: boolean }>('SELECT pg_advisory_unlock($1, hashtext($2)) AS ok', [
              LOCK_WORKSPACE_WRITE,
              workspaceId,
            ])
            .then((result) => result.rows[0]?.ok === true)
            .catch(() => false);
          gate.release(released ? undefined : new Error('workspace lock was not released'));
        }
      });
    },
  };
}
