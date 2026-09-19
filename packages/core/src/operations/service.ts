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
  commit(operation: OperationRecord): Promise<{ commitHash: string; taxonomyVersion?: number }>;
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
        // Nothing was committed, or we cannot tell. Recovery decides by looking
        // for a commit that names this operation.
        await this.fail(operation, error);
        throw error;
      }

      const afterCommit: OperationRecord = {
        ...operation,
        state: 'git_committed',
        gitCommitHash: committed.commitHash,
        taxonomyVersion:
          committed.taxonomyVersion === undefined ? null : String(committed.taxonomyVersion),
        updatedAt: this.clock.now(),
      };
      await this.o.uow.run((tx) =>
        this.o.operations.update(tx, actor.workspaceId, operation.id, {
          state: afterCommit.state,
          gitCommitHash: afterCommit.gitCommitHash,
          taxonomyVersion: afterCommit.taxonomyVersion,
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

  private async fail(operation: OperationRecord, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.o.uow.run((tx) =>
      this.o.operations.update(tx, operation.workspaceId, operation.id, {
        state: 'failed',
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
