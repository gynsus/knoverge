import type { EventType, WebhookId, WorkspaceId } from '@knoverge/contracts';

import type { Tx } from '../ports/unit-of-work.ts';

export interface WebhookRecord {
  id: WebhookId;
  workspaceId: WorkspaceId;
  url: string;
  /** Sealed with `KNOVERGE_ENCRYPTION_KEY`. Never served, never logged. */
  secretCiphertext: string;
  /** Which event types to deliver. Empty means every type. */
  eventTypes: EventType[];
  status: 'active' | 'disabled';
  /** How far down the workspace's ledger this endpoint has been told. */
  cursor: number;
  failures: number;
  nextAttemptAt: Date | null;
  lastDeliveryAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WebhookPatch {
  url?: string;
  secretCiphertext?: string;
  eventTypes?: EventType[];
  status?: 'active' | 'disabled';
  cursor?: number;
  failures?: number;
  nextAttemptAt?: Date | null;
  lastDeliveryAt?: Date | null;
  lastError?: string | null;
  updatedAt: Date;
}

export interface WebhookRepository {
  insert(tx: Tx, webhook: WebhookRecord): Promise<void>;
  update(tx: Tx, workspaceId: WorkspaceId, id: WebhookId, patch: WebhookPatch): Promise<void>;
  remove(tx: Tx, workspaceId: WorkspaceId, id: WebhookId): Promise<void>;
  findById(workspaceId: WorkspaceId, id: WebhookId): Promise<WebhookRecord | null>;
  list(workspaceId: WorkspaceId): Promise<WebhookRecord[]>;
  /**
   * Every active endpoint across every workspace that is due an attempt.
   *
   * Across workspaces because one sweep runs for the installation: a job per
   * workspace would be a schedule that grows with the data.
   */
  listDue(now: Date, limit: number): Promise<WebhookRecord[]>;
}
