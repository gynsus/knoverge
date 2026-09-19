import type { WorkspaceId } from '@knoverge/contracts';

import type { Tx } from '../ports/unit-of-work.ts';
import type { EventRecord } from './types.ts';

export interface LedgerHead {
  sequence: number;
  eventHash: string;
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
}
