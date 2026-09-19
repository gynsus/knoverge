import type { ActorId, WorkspaceId } from '@knoverge/contracts';

import type { Tx } from '../ports/unit-of-work.ts';

export interface IdempotencyRecord {
  workspaceId: WorkspaceId;
  actorId: ActorId;
  idempotencyKey: string;
  requestHash: string;
  response: Record<string, unknown>;
  createdAt: Date;
  expiresAt: Date;
}

export interface IdempotencyRepository {
  find(workspaceId: WorkspaceId, actorId: ActorId, key: string): Promise<IdempotencyRecord | null>;
  /** Stores the outcome for a key, replacing an expired record for the same key. */
  store(tx: Tx, record: IdempotencyRecord): Promise<void>;
  /** Removes records past their expiry. Returns how many were removed. */
  deleteExpired(tx: Tx, now: Date): Promise<number>;
}
