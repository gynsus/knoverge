import type { ActorId, AgentId, AgentStatus, TrustTier, WorkspaceId } from '@knoverge/contracts';

import type { Tx } from '../ports/unit-of-work.ts';

export interface AgentRecord {
  id: AgentId;
  workspaceId: WorkspaceId;
  actorId: ActorId;
  name: string;
  description: string | null;
  clientType: string | null;
  trustTier: TrustTier;
  status: AgentStatus;
  createdByActorId: ActorId;
  createdAt: Date;
  lastSeenAt: Date | null;
  metadata: Record<string, unknown>;
}

export type AgentPatch = Partial<
  Pick<AgentRecord, 'name' | 'description' | 'clientType' | 'trustTier' | 'status'>
>;

export interface AgentRepository {
  insert(tx: Tx, agent: AgentRecord): Promise<void>;
  /**
   * The workspace is part of the statement, not only of the caller's earlier
   * lookup. A service that forgets the lookup would otherwise reach across
   * workspaces, and the boundary should hold at the statement.
   */
  update(tx: Tx, workspaceId: WorkspaceId, id: AgentId, patch: AgentPatch): Promise<void>;
  findById(workspaceId: WorkspaceId, id: AgentId): Promise<AgentRecord | null>;
  findByName(workspaceId: WorkspaceId, name: string): Promise<AgentRecord | null>;
  list(workspaceId: WorkspaceId): Promise<AgentRecord[]>;
  touchLastSeen(id: AgentId, at: Date): Promise<void>;
}

export interface CredentialRecord {
  id: string;
  agentId: AgentId;
  tokenHash: string;
  tokenPrefix: string;
  label: string | null;
  createdByActorId: ActorId;
  createdAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
}

/** A credential joined with the agent and workspace it authenticates. */
export interface ResolvedCredential {
  credential: CredentialRecord;
  agent: AgentRecord;
}

export interface CredentialRepository {
  insert(tx: Tx, credential: CredentialRecord): Promise<void>;
  findByTokenHash(tokenHash: string): Promise<ResolvedCredential | null>;
  findById(id: string): Promise<CredentialRecord | null>;
  listForAgent(agentId: AgentId): Promise<CredentialRecord[]>;
  countActive(agentId: AgentId, now: Date): Promise<number>;
  revoke(tx: Tx, id: string, at: Date): Promise<boolean>;
  revokeAllForAgent(tx: Tx, agentId: AgentId, at: Date): Promise<number>;
  touchLastUsed(id: string, at: Date): Promise<void>;
}
