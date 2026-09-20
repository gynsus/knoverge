import type { ActorId, AgentId, WorkspaceId } from '@knoverge/contracts';

import type { Tx } from '../ports/unit-of-work.ts';

/**
 * How far a canonical write got. The order is fixed: an operation is recorded
 * as pending before anything is written, becomes git_committed once the commit
 * exists, and db_committed once PostgreSQL has caught up.
 */
export type OperationState = 'pending' | 'git_committed' | 'db_committed' | 'failed' | 'recovered';

export type OperationType =
  'taxonomy' | 'create' | 'update' | 'delete' | 'restore' | 'move' | 'supersede' | 'import';

export interface OperationRecord {
  id: string;
  workspaceId: WorkspaceId;
  actorId: ActorId;
  operationType: OperationType;
  state: OperationState;
  /** What the write is about, so recovery can report it without reading Git. */
  objectIds: Record<string, unknown>;
  intendedPayloadHash: string | null;
  gitCommitHash: string | null;
  taxonomyVersion: number | null;
  /**
   * The request context, kept because recovery rebuilds a ledger event from
   * this row and the commit trailers, and the trailers do not carry it.
   */
  requestId: string;
  sessionId: string | null;
  agentId: AgentId | null;
  client: string | null;
  provider: string | null;
  model: string | null;
  error: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export type OperationPatch = Partial<
  Pick<
    OperationRecord,
    'state' | 'gitCommitHash' | 'taxonomyVersion' | 'error' | 'objectIds' | 'updatedAt'
  >
>;

export interface OperationRepository {
  insert(tx: Tx, operation: OperationRecord): Promise<void>;
  update(tx: Tx, workspaceId: WorkspaceId, id: string, patch: OperationPatch): Promise<void>;
  findById(workspaceId: WorkspaceId, id: string, tx?: Tx): Promise<OperationRecord | null>;
  /** Operations that never reached db_committed, oldest first. */
  listUnfinished(workspaceId: WorkspaceId, limit?: number): Promise<OperationRecord[]>;
  /**
   * Workspaces holding an unfinished operation, so startup does not have to
   * take the write lock of every workspace to find the few that need it.
   */
  workspacesUnfinished(limit?: number): Promise<WorkspaceId[]>;
}
