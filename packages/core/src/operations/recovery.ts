import type { WorkspaceId } from '@knoverge/contracts';

import type { Clock } from '../ports/clock.ts';
import { systemClock } from '../ports/clock.ts';
import type { UnitOfWork } from '../ports/unit-of-work.ts';
import type { OperationRecord, OperationRepository } from './repository.ts';

export interface RecoveryOptions {
  uow: UnitOfWork;
  operations: OperationRepository;
  /**
   * Whether a commit naming this operation exists. Supplied by the Git store;
   * until one exists, an installation with no repository answers false, which
   * is correct: no commit was made, so the operation failed.
   */
  commitExists(workspaceId: WorkspaceId, operationId: string): Promise<boolean>;
  /**
   * Completes the PostgreSQL side of an operation that reached Git, from the
   * commit and the request context stored on the row. Returns false when it
   * cannot, which leaves the operation for an operator to look at.
   */
  completeFromCommit?(operation: OperationRecord): Promise<boolean>;
  clock?: Clock;
}

export interface RecoveryReport {
  examined: number;
  failed: string[];
  recovered: string[];
  unresolved: string[];
}

/**
 * Finishes or abandons writes that were interrupted between Git and PostgreSQL
 * (ARCHITECTURE.md section 4).
 *
 * Runs at startup and from the integrity checker, holding the workspace write
 * lock so it cannot race a live write on another process. The rules are the
 * ones the architecture states:
 *
 * - pending with no commit naming it: the write never happened, mark failed;
 * - git_committed with no revision rows: rebuild the PostgreSQL side from the
 *   commit and mark recovered;
 * - a revision with no commit: impossible by construction, because Git commits
 *   first. It is reported rather than repaired.
 */
export class RecoveryService {
  private readonly o: RecoveryOptions;
  private readonly clock: Clock;

  constructor(options: RecoveryOptions) {
    this.o = options;
    this.clock = options.clock ?? systemClock;
  }

  /**
   * Recovers every workspace that has an unfinished operation.
   *
   * Called at startup, before the workspace would refuse a write for holding
   * one. A workspace with nothing unfinished is not locked at all, so this
   * costs one query on an installation that shut down cleanly.
   */
  async recoverAll(): Promise<Record<string, RecoveryReport>> {
    const workspaces = await this.o.operations.workspacesUnfinished();
    const reports: Record<string, RecoveryReport> = {};
    for (const workspaceId of workspaces) {
      reports[workspaceId] = await this.recover(workspaceId);
    }
    return reports;
  }

  async recover(workspaceId: WorkspaceId): Promise<RecoveryReport> {
    const report: RecoveryReport = { examined: 0, failed: [], recovered: [], unresolved: [] };
    await this.o.uow.withWorkspaceLock(workspaceId, async () => {
      const unfinished = await this.o.operations.listUnfinished(workspaceId);
      report.examined = unfinished.length;
      for (const operation of unfinished) {
        if (operation.state === 'pending') {
          // Nothing was recorded as committed. A commit may still exist if the
          // process died between committing and writing the hash, so the Git
          // store is asked before the operation is abandoned.
          if (await this.o.commitExists(workspaceId, operation.id)) {
            report.unresolved.push(operation.id);
            continue;
          }
          await this.mark(operation, 'failed', { reason: 'no commit for a pending operation' });
          report.failed.push(operation.id);
          continue;
        }
        const completed = this.o.completeFromCommit
          ? await this.o.completeFromCommit(operation)
          : false;
        if (completed) {
          await this.mark(operation, 'recovered', null);
          report.recovered.push(operation.id);
        } else {
          report.unresolved.push(operation.id);
        }
      }
    });
    return report;
  }

  private async mark(
    operation: OperationRecord,
    state: 'failed' | 'recovered',
    error: Record<string, unknown> | null,
  ): Promise<void> {
    await this.o.uow.run((tx) =>
      this.o.operations.update(tx, operation.workspaceId, operation.id, {
        state,
        error,
        updatedAt: this.clock.now(),
      }),
    );
  }
}
