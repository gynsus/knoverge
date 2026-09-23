import type { WorkspaceId } from '@knoverge/contracts';

import type { ActorContext } from '../actor-context.ts';
import { DomainError } from '../errors.ts';
import { newId } from '../ids.ts';
import type { Clock } from '../ports/clock.ts';
import { systemClock } from '../ports/clock.ts';
import type { Tx, UnitOfWork } from '../ports/unit-of-work.ts';
import type { OperationRecord, OperationRepository, OperationType } from './repository.ts';

export interface CrossStoreOptions {
  uow: UnitOfWork;
  operations: OperationRepository;
  /**
   * Whether a commit naming an operation exists. Asked before an interrupted
   * write is closed, and before a new write is allowed to proceed.
   */
  commitExists(workspaceId: WorkspaceId, operationId: string): Promise<boolean>;
  clock?: Clock;
}

export interface CrossStoreWrite<T> {
  type: OperationType;
  /** What the write is about, recorded before anything is written. */
  objectIds: Record<string, unknown>;
  /**
   * Writes the files and returns the commit. Called once, never retried: a
   * commit that happened cannot be made not to have happened, so a failure
   * here leaves the operation pending for recovery to abandon.
   */
  commit(operation: OperationRecord): Promise<{
    commitHash: string;
    taxonomyVersion?: number;
    /**
     * What the write turned out to be about. Validation happens inside this
     * step, because it has to run under the lock and before anything is
     * written, so the pending row is recorded before the ids are known.
     */
    objectIds?: Record<string, unknown>;
  }>;
  /**
   * The PostgreSQL side, in one transaction: revision metadata, the object,
   * the ledger event. Runs after the commit exists, so it can record its hash.
   */
  record(tx: Tx, operation: OperationRecord): Promise<T>;
}

/**
 * Runs a write that spans PostgreSQL and Git in the order ARCHITECTURE.md
 * section 4 fixes, under a lock held for the whole of it.
 *
 * The lock is session-scoped on a connection of its own, because the write
 * spans three transactions and a commit: a transaction-scoped lock would be
 * released before the commit. A process that dies loses its connection and the
 * lock with it, leaving the operation row behind, which is what recovery is
 * for. A lock that outlived a dead process would need an expiry, and an expiry
 * is a second way to end up with two writers.
 */
export class CrossStoreWriter {
  private readonly o: CrossStoreOptions;
  private readonly clock: Clock;

  constructor(options: CrossStoreOptions) {
    this.o = options;
    this.clock = options.clock ?? systemClock;
  }

  async run<T>(actor: ActorContext, write: CrossStoreWrite<T>): Promise<T> {
    return this.o.uow.withWorkspaceLock(actor.workspaceId, async () => {
      await this.assertNothingUnfinished(actor.workspaceId);
      const now = this.clock.now();
      const operation: OperationRecord = {
        id: newId('op'),
        workspaceId: actor.workspaceId,
        actorId: actor.actorId,
        operationType: write.type,
        state: 'pending',
        objectIds: write.objectIds,
        intendedPayloadHash: null,
        gitCommitHash: null,
        taxonomyVersion: null,
        requestId: actor.requestId,
        sessionId: actor.sessionId ?? null,
        agentId: actor.agentId ?? null,
        client: actor.client ?? null,
        provider: actor.provider ?? null,
        model: actor.model ?? null,
        error: null,
        createdAt: now,
        updatedAt: now,
      };
      await this.o.uow.run((tx) => this.o.operations.insert(tx, operation));

      let committed;
      try {
        committed = await write.commit(operation);
      } catch (error) {
        await this.close(operation, error);
        throw error;
      }

      const afterCommit: OperationRecord = {
        ...operation,
        state: 'git_committed',
        gitCommitHash: committed.commitHash,
        taxonomyVersion: committed.taxonomyVersion ?? null,
        objectIds: committed.objectIds ?? operation.objectIds,
        updatedAt: this.clock.now(),
      };
      await this.o.uow.run((tx) =>
        this.o.operations.update(tx, actor.workspaceId, operation.id, {
          state: afterCommit.state,
          gitCommitHash: afterCommit.gitCommitHash,
          taxonomyVersion: afterCommit.taxonomyVersion,
          objectIds: afterCommit.objectIds,
          updatedAt: afterCommit.updatedAt,
        }),
      );

      // One transaction for the whole PostgreSQL side, so the object, its
      // revision, the event and the operation's own state commit together.
      return this.o.uow.run(async (tx) => {
        const result = await write.record(tx, afterCommit);
        await this.o.operations.update(tx, actor.workspaceId, operation.id, {
          state: 'db_committed',
          updatedAt: this.clock.now(),
        });
        return result;
      });
    });
  }

  /**
   * Refuses to start a write while an earlier one in this workspace is
   * unfinished.
   *
   * An interrupted write leaves the repository holding a change PostgreSQL does
   * not have. Writing on top of that state re-renders the whole file from a
   * database that is missing the change, so the next commit silently deletes
   * the earlier one — and takes its taxonomy version number, because the number
   * is only recorded when PostgreSQL commits. Stopping is the only safe answer:
   * the two stores disagree, and this process cannot tell which is right.
   *
   * Recovery resolves these — at startup, and on demand through
   * `knoverge db recover` — so the ordinary case is that a workspace is never
   * seen in this state at all.
   */
  private async assertNothingUnfinished(workspaceId: WorkspaceId): Promise<void> {
    const unfinished = await this.o.operations.listUnfinished(workspaceId, 1);
    const blocking = unfinished[0];
    if (!blocking) return;
    throw new DomainError(
      'INTERNAL_ERROR',
      'an earlier change to this workspace did not finish, so the repository and the database may disagree; an operator can resolve it with `knoverge db recover`, which the server also does at startup',
      { objectIds: { workspace_id: workspaceId, operation: blocking.id, state: blocking.state } },
    );
  }

  /**
   * Closes an operation whose commit step threw.
   *
   * Asks Git first, because the throw may have come after the commit — the
   * store commits and then reads the hash back, and anything between the two
   * lands here. `failed` is terminal and recovery never looks at it again, so
   * calling a write that did commit `failed` abandons a commit that is already
   * in history. When a commit exists the row is left `pending` for recovery,
   * with the error recorded so an operator can see what happened.
   */
  private async close(operation: OperationRecord, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const committed = await this.o
      .commitExists(operation.workspaceId, operation.id)
      // Cannot tell, so assume the worse of the two: leave it for recovery.
      .catch(() => true);
    await this.o.uow.run((tx) =>
      this.o.operations.update(tx, operation.workspaceId, operation.id, {
        state: committed ? 'pending' : 'failed',
        error: { message },
        updatedAt: this.clock.now(),
      }),
    );
  }
}

/** Raised when an operation is asked for and is not there. */
export function operationNotFound(id: string): DomainError {
  return new DomainError('NOT_FOUND', `operation ${id} not found`, {
    objectIds: { operation: id },
  });
}
