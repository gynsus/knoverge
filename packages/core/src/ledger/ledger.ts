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
      hashVersion: HASH_VERSION,
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
      metadata: jsonSafe(input.metadata ?? {}),
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

/**
 * The exact field set the hash covers, in one place.
 *
 * It is an explicit list rather than a spread of the row: a migration that adds
 * a column must not silently change the hash of every event ever written, which
 * would make historical verification fail. A change to this list is a new
 * version, and each event records the version it was hashed with, so old events
 * keep verifying.
 */
export const HASH_VERSION = 1;

const HASHERS: Record<number, (event: Omit<EventRecord, 'eventHash'>) => Record<string, unknown>> =
  {
    1: (e) => ({
      v: 1,
      id: e.id,
      workspace_id: e.workspaceId,
      sequence: e.sequence,
      event_type: e.eventType,
      actor_id: e.actorId,
      agent_id: e.agentId,
      request_id: e.requestId,
      session_id: e.sessionId,
      client: e.client,
      provider: e.provider,
      model: e.model,
      object_type: e.objectType,
      object_id: e.objectId,
      before_revision_id: e.beforeRevisionId,
      before_content_hash: e.beforeContentHash,
      after_revision_id: e.afterRevisionId,
      after_content_hash: e.afterContentHash,
      proposal_id: e.proposalId,
      source_reference_id: e.sourceReferenceId,
      category_ids: e.categoryIds,
      metadata: e.metadata,
      prev_event_hash: e.prevEventHash,
      created_at: e.createdAt,
    }),
  };

function hashable(event: Omit<EventRecord, 'eventHash'>): Record<string, unknown> {
  const hasher = HASHERS[event.hashVersion];
  if (!hasher) {
    throw new Error(`unknown event hash version ${event.hashVersion}`);
  }
  return hasher(event);
}

/**
 * Drops undefined values so that what is hashed matches what jsonb stores:
 * canonical JSON would write them as null, while the database omits the key.
 */
function jsonSafe(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [
        k,
        v !== null && typeof v === 'object' && !Array.isArray(v)
          ? jsonSafe(v as Record<string, unknown>)
          : v,
      ]),
  );
}
