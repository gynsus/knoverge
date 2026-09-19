import { createHash } from 'node:crypto';

import type { ActorContext } from '../actor-context.ts';
import { DomainError } from '../errors.ts';
import { canonicalJson } from '../ledger/canonical-json.ts';
import type { Clock } from '../ports/clock.ts';
import { systemClock } from '../ports/clock.ts';
import type { UnitOfWork } from '../ports/unit-of-work.ts';
import type { IdempotencyRepository } from './repository.ts';

/** How long a key is honoured. Long enough for retries, short enough to prune. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export const IdempotencyKeyPattern = /^[A-Za-z0-9._:-]{8,200}$/;

export interface IdempotencyServiceOptions {
  uow: UnitOfWork;
  records: IdempotencyRepository;
  clock?: Clock;
  ttlMs?: number;
}

export interface IdempotentResult<T> {
  value: T;
  /** True when the stored response of an earlier identical call was returned. */
  replayed: boolean;
}

/**
 * Makes a mutation safe to retry (CLAUDE.md, API design rules).
 *
 * The same key with the same request returns the first response; the same key
 * with a different request is refused, because the caller is reusing a key for
 * something else. Responses that contain a secret must not be stored, so an
 * operation that mints one is deliberately not made idempotent.
 *
 * This covers a client retrying after a timeout, which is what retries look
 * like. Two genuinely simultaneous calls with the same key may both run, and
 * the record then holds the later response; guarding an operation against
 * running twice at the same instant is the operation's own job.
 */
export class IdempotencyService {
  private readonly o: IdempotencyServiceOptions;
  private readonly clock: Clock;
  private readonly ttlMs: number;

  constructor(options: IdempotencyServiceOptions) {
    this.o = options;
    this.clock = options.clock ?? systemClock;
    this.ttlMs = options.ttlMs ?? IDEMPOTENCY_TTL_MS;
  }

  /**
   * Stable fingerprint of a call, so a replay can be told from a reuse. The
   * operation is part of it: two endpoints whose bodies happen to canonicalise
   * the same must not replay each other's stored response.
   */
  static fingerprint(operation: string, request: unknown): string {
    const payload = canonicalJson({ op: operation, request });
    return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
  }

  async run<T extends Record<string, unknown>>(
    actor: ActorContext,
    key: string | undefined,
    operation: string,
    request: unknown,
    fn: () => Promise<T>,
  ): Promise<IdempotentResult<T>> {
    if (key === undefined) {
      return { value: await fn(), replayed: false };
    }
    if (!IdempotencyKeyPattern.test(key)) {
      throw new DomainError(
        'VALIDATION_ERROR',
        'idempotency key must be 8 to 200 characters of letters, digits, dot, dash, colon or underscore',
      );
    }
    const fingerprint = IdempotencyService.fingerprint(operation, request);
    const now = this.clock.now();
    const existing = await this.o.records.find(actor.workspaceId, actor.actorId, key);
    if (existing && existing.expiresAt > now) {
      if (existing.requestHash !== fingerprint) {
        throw new DomainError(
          'VALIDATION_ERROR',
          'this idempotency key was used for a different request',
          { objectIds: { idempotency_key: key } },
        );
      }
      return { value: existing.response as T, replayed: true };
    }

    const value = await fn();
    await this.o.uow.run((tx) =>
      this.o.records.store(tx, {
        workspaceId: actor.workspaceId,
        actorId: actor.actorId,
        idempotencyKey: key,
        requestHash: fingerprint,
        response: value,
        createdAt: now,
        expiresAt: new Date(now.getTime() + this.ttlMs),
      }),
    );
    return { value, replayed: false };
  }

  /** Removes expired records. Called from maintenance, not from a request. */
  purgeExpired(): Promise<number> {
    return this.o.uow.run((tx) => this.o.records.deleteExpired(tx, this.clock.now()));
  }
}
