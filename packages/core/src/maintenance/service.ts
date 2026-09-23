import type { SessionRepository } from '../identity/repository.ts';
import type { OperationRepository } from '../operations/repository.ts';
import type { ProposalRepository } from '../proposals/repository.ts';
import type { SyncRepository } from '../sync/repository.ts';
import type { Clock } from '../ports/clock.ts';
import { systemClock } from '../ports/clock.ts';
import type { UnitOfWork } from '../ports/unit-of-work.ts';
import type { IdempotencyService } from '../idempotency/service.ts';

/** How long a session row is kept after it stops working. */
export const SESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How long a decided operation row is kept.
 *
 * The row exists so an interrupted write can be finished or abandoned. Once it
 * is decided it is history, and the ledger is where history belongs. Nothing
 * removed them before, and a caller can produce one per rejected request —
 * hundreds of thousands a day at the per-actor rate limit.
 */
export const OPERATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How long the proposed text of a resolved proposal is kept.
 *
 * A proposal row is the only place outside Git that holds proposed knowledge,
 * including text a reviewer rejected and nobody ever agreed to store. Once the
 * decision is old enough to be beyond dispute the text goes and the row stays,
 * so the workspace keeps who proposed what kind of change, when, and what was
 * decided, without keeping the content indefinitely. Longer than an operation
 * row, because a disagreement about a review surfaces later than one about a
 * half-finished write.
 */
export const PROPOSAL_PAYLOAD_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * How long the candidates of a finished reconciliation pass are kept.
 *
 * An agent syncing daily with a thousand candidates leaves three hundred
 * thousand rows a year, each carrying up to a thousand characters of its own
 * description of its own material. Nothing reads them once the pass is over:
 * what it found is in the session's stats and what it proposed is in the
 * proposals. The same ninety days the proposed text gets, for the same
 * reason — it is the same kind of content.
 */
export const SYNC_CANDIDATE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export interface MaintenanceOptions {
  uow: UnitOfWork;
  sessions: SessionRepository;
  operations: OperationRepository;
  proposals: ProposalRepository;
  sync: SyncRepository;
  idempotency: IdempotencyService;
  clock?: Clock;
  sessionRetentionMs?: number;
  operationRetentionMs?: number;
  proposalPayloadRetentionMs?: number;
  syncCandidateRetentionMs?: number;
}

export interface MaintenanceResult {
  idempotencyRecords: number;
  sessions: number;
  operations: number;
  /** Resolved proposals whose text was emptied, not rows removed. */
  redactedProposals: number;
  /** Candidates of finished passes removed; the passes themselves stay. */
  syncCandidates: number;
}

/**
 * Removes rows nothing reads any more.
 *
 * Idempotency records hold a whole stored response and stop being honoured
 * after a day; session rows stop working at their expiry or when revoked; an
 * operation row stops being interesting once it has been decided. The data
 * model says these are removed by maintenance rather than on the request path,
 * and until this existed nothing removed them, so the tables grew for the life
 * of the installation.
 */
export class MaintenanceService {
  private readonly o: MaintenanceOptions;
  private readonly clock: Clock;
  private readonly retentionMs: number;
  private readonly operationRetentionMs: number;
  private readonly proposalPayloadRetentionMs: number;
  private readonly syncCandidateRetentionMs: number;

  constructor(options: MaintenanceOptions) {
    this.o = options;
    this.clock = options.clock ?? systemClock;
    this.retentionMs = options.sessionRetentionMs ?? SESSION_RETENTION_MS;
    this.operationRetentionMs = options.operationRetentionMs ?? OPERATION_RETENTION_MS;
    this.proposalPayloadRetentionMs =
      options.proposalPayloadRetentionMs ?? PROPOSAL_PAYLOAD_RETENTION_MS;
    this.syncCandidateRetentionMs = options.syncCandidateRetentionMs ?? SYNC_CANDIDATE_RETENTION_MS;
  }

  async prune(): Promise<MaintenanceResult> {
    const idempotencyRecords = await this.o.idempotency.purgeExpired();
    const now = this.clock.now();
    const before = new Date(now.getTime() - this.retentionMs);
    const sessions = await this.o.uow.run((tx) => this.o.sessions.deleteEndedBefore(tx, before));
    // Decided ones only: an unfinished operation is what recovery reads, and
    // removing one would let the next write proceed over a repository the
    // database does not agree with.
    const operations = await this.o.uow.run((tx) =>
      this.o.operations.deleteDecidedBefore(
        tx,
        new Date(now.getTime() - this.operationRetentionMs),
      ),
    );
    // Emptied, not deleted: a proposal row is part of the review trail, and
    // removing it would lose that somebody asked and somebody answered.
    const redactedProposals = await this.o.uow.run((tx) =>
      this.o.proposals.redactResolvedBefore(
        tx,
        new Date(now.getTime() - this.proposalPayloadRetentionMs),
      ),
    );
    // Removed, not emptied: a candidate is one agent's note about its own
    // material, not part of anybody's review trail. What the pass found
    // survives in the session's stats.
    const syncCandidates = await this.o.uow.run((tx) =>
      this.o.sync.deleteCandidatesCompletedBefore(
        tx,
        new Date(now.getTime() - this.syncCandidateRetentionMs),
      ),
    );
    return { idempotencyRecords, sessions, operations, redactedProposals, syncCandidates };
  }
}
