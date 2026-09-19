import type { ActorId, ActorType, AgentId, WorkspaceId } from '@knoverge/contracts';

/**
 * Who is acting, resolved by the adapter from credentials and request metadata.
 * Every material write records these fields on its ledger event (CLAUDE.md rule 3).
 */
export interface ActorContext {
  workspaceId: WorkspaceId;
  actorId: ActorId;
  actorType: ActorType;
  agentId?: AgentId;
  requestId: string;
  sessionId?: string;
  client?: string;
  provider?: string;
  model?: string;
}
