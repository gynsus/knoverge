import { z } from 'zod';

/**
 * Object id prefixes (DATA_MODEL.md section 0). Ids are prefixed ULIDs.
 */
export const ID_PREFIXES = {
  workspace: 'ws',
  user: 'usr',
  membership: 'mem',
  actor: 'act',
  agent: 'ag',
  credential: 'cred',
  session: 'sess',
  category: 'cat',
  categoryAlias: 'alias',
  knowledgeItem: 'kn',
  revision: 'rev',
  sourceReference: 'src',
  relation: 'rel',
  tag: 'tag',
  proposal: 'prop',
  event: 'evt',
  operation: 'op',
  syncSession: 'sync',
  syncCandidate: 'cand',
  attachment: 'att',
  webhook: 'hook',
  policyRule: 'rule',
  permissionGrant: 'grant',
  searchChunk: 'chunk',
} as const;

export type IdPrefix = (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES];

const ULID = '[0-9A-HJKMNP-TV-Z]{26}';

export function idSchema<P extends IdPrefix>(prefix: P) {
  return z
    .string()
    .regex(new RegExp(`^${prefix}_${ULID}$`), `expected an id with prefix ${prefix}_`)
    .brand<`Id<${P}>`>();
}

export const WorkspaceId = idSchema('ws');
export type WorkspaceId = z.infer<typeof WorkspaceId>;
export const UserId = idSchema('usr');
export type UserId = z.infer<typeof UserId>;
export const ActorId = idSchema('act');
export type ActorId = z.infer<typeof ActorId>;
export const AgentId = idSchema('ag');
export type AgentId = z.infer<typeof AgentId>;
export const SessionId = idSchema('sess');
export type SessionId = z.infer<typeof SessionId>;
export const EventId = idSchema('evt');
export type EventId = z.infer<typeof EventId>;
export const CategoryId = idSchema('cat');
export type CategoryId = z.infer<typeof CategoryId>;

export const KnowledgeItemId = idSchema('kn');
export type KnowledgeItemId = z.infer<typeof KnowledgeItemId>;
export const RevisionId = idSchema('rev');
export type RevisionId = z.infer<typeof RevisionId>;
export const SourceReferenceId = idSchema('src');
export type SourceReferenceId = z.infer<typeof SourceReferenceId>;
export const RelationId = idSchema('rel');
export type RelationId = z.infer<typeof RelationId>;

export const ProposalId = idSchema('prop');
export type ProposalId = z.infer<typeof ProposalId>;

export const PolicyRuleId = idSchema('rule');
export type PolicyRuleId = z.infer<typeof PolicyRuleId>;
export const PermissionGrantId = idSchema('grant');
export type PermissionGrantId = z.infer<typeof PermissionGrantId>;
export const CredentialId = idSchema('cred');
export type CredentialId = z.infer<typeof CredentialId>;
