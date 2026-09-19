import type { EventId, WorkspaceId } from '@knoverge/contracts';

import { newId } from '../ids.ts';
import type { Clock } from '../ports/clock.ts';
import { systemClock } from '../ports/clock.ts';
import type { Tx } from '../ports/unit-of-work.ts';
import { computeEventHash, genesisHash, type LedgerKey } from './hash.ts';
import type { EventRepository } from './repository.ts';
import type { EventActor, EventInput, EventRecord } from './types.ts';

export interface LedgerOptions {
  key: LedgerKey;
  events: EventRepository;
  clock?: Clock;
}

export interface VerifyResult {
  ok: boolean;
  /** Events checked. */
  count: number;
  /** First sequence whose hash did not verify, when not ok. */
  brokenAt?: number;
  reason?: string;
}

/**
 * Append-only, keyed hash-chained event ledger (ADR 0007).
 */
export class EventLedger {
  private readonly key: LedgerKey;
  private readonly events: EventRepository;
  private readonly clock: Clock;

  constructor(options: LedgerOptions) {
    this.key = options.key;
    this.events = options.events;
    this.clock = options.clock ?? systemClock;
  }

  /**
   * Appends one event inside the caller's transaction. Must be called after the
   * domain change it describes, in the same transaction, so both commit together.
   */
  async append(
    tx: Tx,
    workspaceId: WorkspaceId,
    actor: EventActor,
    input: EventInput,
  ): Promise<EventRecord> {
    const head = await this.events.lockAndGetHead(tx, workspaceId);
    const sequence = (head?.sequence ?? 0) + 1;
    const prevEventHash = head?.eventHash ?? genesisHash(this.key);
    const unhashed: Omit<EventRecord, 'eventHash'> = {
      id: newId('evt') as EventId,
      workspaceId,
      sequence,
      eventType: input.eventType,
      actorId: actor.actorId,
      agentId: actor.agentId ?? null,
      requestId: actor.requestId,
      sessionId: actor.sessionId ?? null,
      client: actor.client ?? null,
      provider: actor.provider ?? null,
      model: actor.model ?? null,
      objectType: input.objectType,
      objectId: input.objectId,
      beforeRevisionId: input.beforeRevisionId ?? null,
      beforeContentHash: input.beforeContentHash ?? null,
      afterRevisionId: input.afterRevisionId ?? null,
      afterContentHash: input.afterContentHash ?? null,
      proposalId: input.proposalId ?? null,
      sourceReferenceId: input.sourceReferenceId ?? null,
      categoryIds: input.categoryIds ?? [],
      metadata: input.metadata ?? {},
      prevEventHash,
      createdAt: this.clock.now(),
    };
    const record: EventRecord = {
      ...unhashed,
      eventHash: computeEventHash(this.key, prevEventHash, hashable(unhashed)),
    };
    await this.events.insert(tx, record);
    return record;
  }

  /**
   * Recomputes every hash in a workspace's ledger. Verification uses only the
   * database and the key; see ADR 0007 for what it does and does not prove.
   */
  async verify(workspaceId: WorkspaceId, pageSize = 500): Promise<VerifyResult> {
    let expectedPrev = genesisHash(this.key);
    let expectedSequence = 1;
    let count = 0;
    let after = 0;
    for (;;) {
      const page = await this.events.listAfter(workspaceId, after, pageSize);
      if (page.length === 0) break;
      for (const event of page) {
        if (event.sequence !== expectedSequence) {
          return { ok: false, count, brokenAt: event.sequence, reason: 'sequence gap' };
        }
        if (event.prevEventHash !== expectedPrev) {
          return { ok: false, count, brokenAt: event.sequence, reason: 'previous hash mismatch' };
        }
        const { eventHash, ...rest } = event;
        const recomputed = computeEventHash(this.key, event.prevEventHash, hashable(rest));
        if (recomputed !== eventHash) {
          return { ok: false, count, brokenAt: event.sequence, reason: 'event hash mismatch' };
        }
        expectedPrev = eventHash;
        expectedSequence += 1;
        count += 1;
        after = event.sequence;
      }
    }
    return { ok: true, count };
  }
}

/** The stored columns that participate in the hash, as a plain object. */
function hashable(event: Omit<EventRecord, 'eventHash'>): Record<string, unknown> {
  return { ...event };
}
