import type { SessionRepository } from '../identity/repository.ts';
import type { OperationRepository } from '../operations/repository.ts';
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

export interface MaintenanceOptions {
  uow: UnitOfWork;
  sessions: SessionRepository;
  operations: OperationRepository;
  idempotency: IdempotencyService;
  clock?: Clock;
  sessionRetentionMs?: number;
  operationRetentionMs?: number;
}

export interface MaintenanceResult {
  idempotencyRecords: number;
  sessions: number;
  operations: number;
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

  constructor(options: MaintenanceOptions) {
    this.o = options;
    this.clock = options.clock ?? systemClock;
    this.retentionMs = options.sessionRetentionMs ?? SESSION_RETENTION_MS;
    this.operationRetentionMs = options.operationRetentionMs ?? OPERATION_RETENTION_MS;
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
    return { idempotencyRecords, sessions, operations };
  }
}
