import type { WorkspaceId } from '@knoverge/contracts';

import type { Tx } from '../ports/unit-of-work.ts';
import type { EventRecord } from './types.ts';

export interface LedgerHead {
  sequence: number;
  eventHash: string;
}

/** What a feed asks of the ledger. */
export interface EventFeedOptions {
  afterSequence: number;
  limit: number;
  eventTypes?: readonly string[] | undefined;
  /** Events whose category snapshot touches one of these. */
  categoryIds?: readonly string[] | undefined;
  /** Only this actor's events, for a caller holding `events.read_own`. */
  actorId?: string | undefined;
}

export interface EventRepository {
  /**
   * Takes the per-workspace append lock for the rest of the transaction and
   * returns the current head, or null for an empty ledger.
   */
  lockAndGetHead(tx: Tx, workspaceId: WorkspaceId): Promise<LedgerHead | null>;
  insert(tx: Tx, record: EventRecord): Promise<void>;
  /** Events with sequence greater than afterSequence, ascending, at most limit. */
  listAfter(workspaceId: WorkspaceId, afterSequence: number, limit: number): Promise<EventRecord[]>;
  /** The same, narrowed. Ascending by sequence, which is the cursor. */
  listFeed(workspaceId: WorkspaceId, options: EventFeedOptions): Promise<EventRecord[]>;
  /** Where both cursors are now, or 0 for a workspace nothing has happened in. */
  latestSequence(workspaceId: WorkspaceId): Promise<number>;
}
