import { z } from 'zod';

import { ActorId, CategoryId, WorkspaceId } from './ids.ts';
import { ActorType, LanguageTag } from './identity.ts';
import { TrustTier } from './agents.ts';

/**
 * Actions a permission grant can allow or deny (DATA_MODEL.md section 9).
 * A grant decides whether an action may be attempted; policy decides how.
 */
export const PermissionAction = z.enum([
  'knowledge.read',
  'knowledge.read_history',
  'knowledge.search',
  'knowledge.propose_create',
  'knowledge.propose_update',
  'knowledge.propose_delete',
  'knowledge.propose_supersede',
  'knowledge.write',
  'knowledge.approve',
  'taxonomy.read',
  'taxonomy.propose',
  'taxonomy.manage',
  'proposal.read_own',
  'proposal.read_all',
  'events.read_own',
  'events.read_all',
  'agent.manage',
  'policy.manage',
  'workspace.admin',
]);
export type PermissionAction = z.infer<typeof PermissionAction>;

export const PermissionEffect = z.enum(['allow', 'deny']);
export type PermissionEffect = z.infer<typeof PermissionEffect>;

export const KnowledgeType = z.enum([
  'fact',
  'decision',
  'instruction',
  'preference',
  'procedure',
  'observation',
  'episode',
  'document',
  'insight',
  'summary',
]);
export type KnowledgeType = z.infer<typeof KnowledgeType>;

export const CategoryScope = z.object({
  category_id: CategoryId,
  include_descendants: z.boolean().default(true),
});
export type CategoryScope = z.infer<typeof CategoryScope>;

/**
 * Where a grant or rule applies. An empty selector means the whole workspace.
 * Categories are referenced by stable id; paths are resolved at the boundary.
 */
export const ScopeSelector = z.object({
  categories: z.array(CategoryScope).max(50).default([]),
  types: z.array(KnowledgeType).max(20).default([]),
  languages: z.array(LanguageTag).max(20).default([]),
});
export type ScopeSelector = z.infer<typeof ScopeSelector>;

export const PermissionGrantSummary = z.object({
  id: z.string(),
  workspace_id: WorkspaceId,
  actor_id: ActorId,
  action: PermissionAction,
  scope: ScopeSelector,
  effect: PermissionEffect,
  created_at: z.iso.datetime(),
});
export type PermissionGrantSummary = z.infer<typeof PermissionGrantSummary>;

export const GrantPermissionRequest = z.object({
  actor_id: ActorId,
  action: PermissionAction,
  effect: PermissionEffect.default('allow'),
  scope: ScopeSelector.optional(),
});
export type GrantPermissionRequest = z.infer<typeof GrantPermissionRequest>;

export const RevokePermissionRequest = z.object({ grant_id: z.string() });
export type RevokePermissionRequest = z.infer<typeof RevokePermissionRequest>;

export const PermissionsQuery = z.object({ actor_id: ActorId.optional() });
export type PermissionsQuery = z.infer<typeof PermissionsQuery>;

export const PermissionsResponse = z.object({ grants: z.array(PermissionGrantSummary) });
export type PermissionsResponse = z.infer<typeof PermissionsResponse>;

/** Actions the policy engine decides on. */
export const PolicyActionName = z.enum([
  'knowledge.create',
  'knowledge.update',
  'knowledge.delete',
  'knowledge.supersede',
  'taxonomy.create',
]);
export type PolicyActionName = z.infer<typeof PolicyActionName>;

export const PolicyEffect = z.enum(['deny', 'allow_direct', 'require_review']);
export type PolicyEffect = z.infer<typeof PolicyEffect>;

export const PolicySubject = z.union([
  z.object({ actor_id: ActorId }),
  z.object({ trust_tier: TrustTier }),
  z.object({ actor_type: ActorType }),
]);
export type PolicySubject = z.infer<typeof PolicySubject>;

export const PolicyRuleSummary = z.object({
  id: z.string(),
  workspace_id: WorkspaceId,
  priority: z.number().int(),
  subject: PolicySubject,
  action: PolicyActionName,
  scope: ScopeSelector,
  effect: PolicyEffect,
  enabled: z.boolean(),
  created_at: z.iso.datetime(),
});
export type PolicyRuleSummary = z.infer<typeof PolicyRuleSummary>;

export const UpsertPolicyRuleRequest = z.object({
  rule_id: z.string().optional(),
  priority: z.number().int().min(0).max(10_000),
  subject: PolicySubject,
  action: PolicyActionName,
  scope: ScopeSelector.optional(),
  effect: PolicyEffect,
  enabled: z.boolean().default(true),
});
export type UpsertPolicyRuleRequest = z.infer<typeof UpsertPolicyRuleRequest>;

export const DeletePolicyRuleRequest = z.object({ rule_id: z.string() });
export type DeletePolicyRuleRequest = z.infer<typeof DeletePolicyRuleRequest>;

export const PolicyRulesResponse = z.object({ rules: z.array(PolicyRuleSummary) });
export type PolicyRulesResponse = z.infer<typeof PolicyRulesResponse>;

export const PolicyRuleResponse = z.object({ rule: PolicyRuleSummary });
export type PolicyRuleResponse = z.infer<typeof PolicyRuleResponse>;
