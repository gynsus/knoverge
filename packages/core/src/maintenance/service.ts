import type { SessionRepository } from '../identity/repository.ts';
import type { Clock } from '../ports/clock.ts';
import { systemClock } from '../ports/clock.ts';
import type { UnitOfWork } from '../ports/unit-of-work.ts';
import type { IdempotencyService } from '../idempotency/service.ts';

/** How long a session row is kept after it stops working. */
export const SESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface MaintenanceOptions {
  uow: UnitOfWork;
  sessions: SessionRepository;
  idempotency: IdempotencyService;
  clock?: Clock;
  sessionRetentionMs?: number;
}

export interface MaintenanceResult {
  idempotencyRecords: number;
  sessions: number;
}

/**
 * Removes rows nothing reads any more.
 *
 * Idempotency records hold a whole stored response and stop being honoured
 * after a day; session rows stop working at their expiry or when revoked. The
 * data model says both are removed by maintenance rather than on the request
 * path, and until this existed nothing removed either, so both tables grew for
 * the life of the installation.
 */
export class MaintenanceService {
  private readonly o: MaintenanceOptions;
  private readonly clock: Clock;
  private readonly retentionMs: number;

  constructor(options: MaintenanceOptions) {
    this.o = options;
    this.clock = options.clock ?? systemClock;
    this.retentionMs = options.sessionRetentionMs ?? SESSION_RETENTION_MS;
  }

  async prune(): Promise<MaintenanceResult> {
    const idempotencyRecords = await this.o.idempotency.purgeExpired();
    const before = new Date(this.clock.now().getTime() - this.retentionMs);
    const sessions = await this.o.uow.run((tx) => this.o.sessions.deleteEndedBefore(tx, before));
    return { idempotencyRecords, sessions };
  }
}
