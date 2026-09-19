import { z } from 'zod';

import { ActorId, AgentId, WorkspaceId } from './ids.ts';

export const TrustTier = z.enum(['read_only', 'propose', 'trusted']);
export type TrustTier = z.infer<typeof TrustTier>;

export const AgentStatus = z.enum(['active', 'disabled']);
export type AgentStatus = z.infer<typeof AgentStatus>;

export const AgentName = z.string().trim().min(1).max(120);
export const ClientType = z.string().trim().min(1).max(64);

export const AgentSummary = z.object({
  id: AgentId,
  workspace_id: WorkspaceId,
  actor_id: ActorId,
  name: AgentName,
  description: z.string().nullable(),
  client_type: z.string().nullable(),
  trust_tier: TrustTier,
  status: AgentStatus,
  created_at: z.iso.datetime(),
  last_seen_at: z.iso.datetime().nullable(),
  /** Credentials that are neither revoked nor expired. */
  active_credentials: z.number().int().nonnegative(),
});
export type AgentSummary = z.infer<typeof AgentSummary>;

export const CreateAgentRequest = z.object({
  name: AgentName,
  description: z.string().trim().max(2000).optional(),
  client_type: ClientType.optional(),
  trust_tier: TrustTier.default('propose'),
});
export type CreateAgentRequest = z.infer<typeof CreateAgentRequest>;

export const UpdateAgentRequest = z.object({
  agent_id: AgentId,
  name: AgentName.optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  client_type: ClientType.nullable().optional(),
  trust_tier: TrustTier.optional(),
  status: AgentStatus.optional(),
});
export type UpdateAgentRequest = z.infer<typeof UpdateAgentRequest>;

export const AgentsResponse = z.object({ agents: z.array(AgentSummary) });
export type AgentsResponse = z.infer<typeof AgentsResponse>;

export const AgentResponse = z.object({ agent: AgentSummary });
export type AgentResponse = z.infer<typeof AgentResponse>;

export const CredentialSummary = z.object({
  id: z.string(),
  agent_id: AgentId,
  token_prefix: z.string(),
  label: z.string().nullable(),
  created_at: z.iso.datetime(),
  expires_at: z.iso.datetime().nullable(),
  revoked_at: z.iso.datetime().nullable(),
  last_used_at: z.iso.datetime().nullable(),
});
export type CredentialSummary = z.infer<typeof CredentialSummary>;

export const IssueCredentialRequest = z.object({
  agent_id: AgentId,
  label: z.string().trim().max(120).optional(),
  /** Days until the credential expires; omit for a credential that does not expire. */
  expires_in_days: z.number().int().min(1).max(3650).optional(),
});
export type IssueCredentialRequest = z.infer<typeof IssueCredentialRequest>;

export const IssueCredentialResponse = z.object({
  credential: CredentialSummary,
  /** Shown once. The server stores only a hash. */
  token: z.string(),
});
export type IssueCredentialResponse = z.infer<typeof IssueCredentialResponse>;

export const RevokeCredentialRequest = z.object({ credential_id: z.string() });
export type RevokeCredentialRequest = z.infer<typeof RevokeCredentialRequest>;

export const CredentialsResponse = z.object({ credentials: z.array(CredentialSummary) });
export type CredentialsResponse = z.infer<typeof CredentialsResponse>;
