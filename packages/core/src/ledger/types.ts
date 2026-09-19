import type { EventId, EventType, ObjectType, WorkspaceId } from '@knoverge/contracts';

import type { ActorContext } from '../actor-context.ts';

/**
 * What a domain service supplies when appending an event. Actor fields come from
 * the ActorContext; sequence, hashes and timestamp are assigned by the ledger.
 */
export interface EventInput {
  eventType: EventType;
  objectType: ObjectType;
  objectId: string;
  beforeRevisionId?: string;
  beforeContentHash?: string;
  afterRevisionId?: string;
  afterContentHash?: string;
  proposalId?: string;
  sourceReferenceId?: string;
  /** Snapshot of the affected item's category ids, for the scoped change feed. */
  categoryIds?: string[];
  /** Safe metadata only: ids, hashes, counts, decision codes. Never knowledge text. */
  metadata?: Record<string, unknown>;
}

export interface EventRecord {
  id: EventId;
  /** Which field set the hash covers. See ADR 0007. */
  hashVersion: number;
  workspaceId: WorkspaceId;
  sequence: number;
  eventType: EventType;
  actorId: string;
  agentId: string | null;
  requestId: string;
  sessionId: string | null;
  client: string | null;
  provider: string | null;
  model: string | null;
  objectType: ObjectType;
  objectId: string;
  beforeRevisionId: string | null;
  beforeContentHash: string | null;
  afterRevisionId: string | null;
  afterContentHash: string | null;
  proposalId: string | null;
  sourceReferenceId: string | null;
  categoryIds: string[];
  metadata: Record<string, unknown>;
  prevEventHash: string;
  eventHash: string;
  createdAt: Date;
}

export type EventActor = Pick<
  ActorContext,
  'actorId' | 'agentId' | 'requestId' | 'sessionId' | 'client' | 'provider' | 'model'
>;
