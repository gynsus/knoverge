import type { EventId, WorkspaceId } from '@knoverge/contracts';

import { newId } from '../ids.ts';
import type { Clock } from '../ports/clock.ts';
import { systemClock } from '../ports/clock.ts';
import type { Tx } from '../ports/unit-of-work.ts';
import {
  computeEventHash,
  genesisHash,
  keyring,
  keysOf,
  type LedgerKey,
  type LedgerKeyring,
} from './hash.ts';
import type { EventRepository } from './repository.ts';
import type { EventActor, EventInput, EventRecord } from './types.ts';

export interface LedgerOptions {
  /** One key, or a keyring after a rotation (ADR 0030). */
  key: LedgerKey | LedgerKeyring;
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
  /**
   * True when a retired key was needed for at least one event.
   *
   * Worth saying: after a rotation a failure is ambiguous between a tampered row
   * and a key nobody kept, and an operator reading a green result should know
   * whether it still depends on a key they might be about to drop.
   */
  usedRetiredKey?: boolean;
}

/**
 * Append-only, keyed hash-chained event ledger (ADR 0007).
 */
export class EventLedger {
  private readonly keys: LedgerKeyring;
  private readonly events: EventRepository;
  private readonly clock: Clock;

  constructor(options: LedgerOptions) {
    this.keys = 'signing' in options.key ? options.key : keyring(options.key);
    this.events = options.events;
    this.clock = options.clock ?? systemClock;
  }

  /** The key that signs. Retired ones verify and never sign. */
  private get key(): LedgerKey {
    return this.keys.signing;
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
    const walker = new ChainWalker(this.keys);
    let after = 0;
    for (;;) {
      const page = await this.events.listAfter(workspaceId, after, pageSize);
      if (page.length === 0) break;
      for (const event of page) {
        const { eventHash, ...rest } = event;
        const failed = walker.next(rest, eventHash);
        if (failed) return failed;
        after = event.sequence;
      }
    }
    return walker.done();
  }
}

/**
 * Walking a chain, one event at a time.
 *
 * One definition of what "the chain holds together" means, because there are two
 * callers: the ledger, reading pages out of the database, and the audit export's
 * verification, reading lines out of a file with no database in sight. Two copies
 * of this rule would be two answers to the only question the ledger exists to
 * answer.
 */
export class ChainWalker {
  private readonly keys: readonly LedgerKey[];
  /**
   * The key the last event verified with, tried first for the next one: a rotation
   * is one boundary in a long chain, so trying keys costs one extra HMAC at that
   * boundary and none anywhere else (ADR 0030).
   */
  private current: LedgerKey;
  private expectedPrev: string | null = null;
  private expectedSequence = 1;
  private usedRetiredKey = false;
  private count = 0;

  constructor(keyring: LedgerKeyring) {
    this.keys = keysOf(keyring);
    this.current = this.keys[0] as LedgerKey;
  }

  /** Feeds one event. Answers a failure, or null when it holds. */
  next(event: Omit<EventRecord, 'eventHash'>, eventHash: string): VerifyResult | null {
    if (event.sequence !== this.expectedSequence) {
      return { ok: false, count: this.count, brokenAt: event.sequence, reason: 'sequence gap' };
    }
    if (this.expectedPrev === null) {
      // The first event: its previous hash is a genesis, and which key made that
      // genesis is what says where this chain started.
      const started = this.keys.find((key) => genesisHash(key) === event.prevEventHash);
      if (!started) {
        return {
          ok: false,
          count: this.count,
          brokenAt: event.sequence,
          reason: 'no configured key produced this chain’s genesis',
        };
      }
      if (started !== this.keys[0]) this.usedRetiredKey = true;
      this.current = started;
    } else if (event.prevEventHash !== this.expectedPrev) {
      return {
        ok: false,
        count: this.count,
        brokenAt: event.sequence,
        reason: 'previous hash mismatch',
      };
    }
    // A row edited to name a version this build does not implement is a broken
    // ledger, which is what verification exists to report.
    const hasher = HASHERS[event.hashVersion];
    if (!hasher) {
      return {
        ok: false,
        count: this.count,
        brokenAt: event.sequence,
        reason: 'unknown hash version',
      };
    }
    const content = hasher(event);
    const signedWith =
      computeEventHash(this.current, event.prevEventHash, content) === eventHash
        ? this.current
        : this.keys.find(
            (key) => computeEventHash(key, event.prevEventHash, content) === eventHash,
          );
    if (!signedWith) {
      return {
        ok: false,
        count: this.count,
        brokenAt: event.sequence,
        reason: 'event hash mismatch',
      };
    }
    if (signedWith !== this.keys[0]) this.usedRetiredKey = true;
    this.current = signedWith;
    this.expectedPrev = eventHash;
    this.expectedSequence += 1;
    this.count += 1;
    return null;
  }

  /** What the walk came to, once there is nothing left to feed it. */
  done(): VerifyResult {
    return {
      ok: true,
      count: this.count,
      ...(this.usedRetiredKey ? { usedRetiredKey: true } : {}),
    };
  }

  /** Where the next event has to start, for a walk that begins part way along. */
  expectSequence(sequence: number, previousHash: string | null): void {
    this.expectedSequence = sequence;
    this.expectedPrev = previousHash;
  }
}

/**
 * The exact field set the hash covers, in one place.
 *
 * Every hasher must emit its own version as `v`. That is what binds the
 * hash_version column: a row edited to name another implemented version selects
 * a hasher that writes a different `v`, so the recomputed hash no longer
 * matches. A hasher that left `v` out would make the column free to edit.
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
