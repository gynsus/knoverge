import { z } from 'zod';

import { ActorId, CategoryId, PermissionGrantId, PolicyRuleId, WorkspaceId } from './ids.ts';
import { CategoryPath } from './taxonomy.ts';
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

/**
 * A scope names a category by id. That is what is stored and what is compared,
 * because a path moves when a category is renamed and a security identifier
 * must not (CLAUDE.md rule 13).
 */
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

/**
 * What a caller may send. A path is a convenience for a person writing a grant
 * by hand, resolved to an id at write time and never stored: rule 13's other
 * half, "paths are accepted at the boundary".
 */
export const CategoryScopeInput = z
  .object({
    category_id: CategoryId.optional(),
    category_path: CategoryPath.optional(),
    include_descendants: z.boolean().default(true),
  })
  .refine((scope) => (scope.category_id === undefined) !== (scope.category_path === undefined), {
    message: 'give either category_id or category_path, not both',
  });
export type CategoryScopeInput = z.infer<typeof CategoryScopeInput>;

export const ScopeSelectorInput = z.object({
  categories: z.array(CategoryScopeInput).max(50).default([]),
  types: z.array(KnowledgeType).max(20).default([]),
  languages: z.array(LanguageTag).max(20).default([]),
});
export type ScopeSelectorInput = z.infer<typeof ScopeSelectorInput>;

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
  /** Retry-safe: the same key with the same body returns the first result. */
  idempotency_key: z.string().optional(),
  actor_id: ActorId,
  action: PermissionAction,
  effect: PermissionEffect.default('allow'),
  scope: ScopeSelectorInput.optional(),
});
export type GrantPermissionRequest = z.infer<typeof GrantPermissionRequest>;

export const RevokePermissionRequest = z.object({ grant_id: PermissionGrantId });
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
  /** Retry-safe: without it a retried create leaves two rules at one priority. */
  idempotency_key: z.string().optional(),
  rule_id: PolicyRuleId.optional(),
  priority: z.number().int().min(0).max(10_000),
  subject: PolicySubject,
  action: PolicyActionName,
  scope: ScopeSelectorInput.optional(),
  effect: PolicyEffect,
  enabled: z.boolean().default(true),
});
export type UpsertPolicyRuleRequest = z.infer<typeof UpsertPolicyRuleRequest>;

export const DeletePolicyRuleRequest = z.object({ rule_id: PolicyRuleId });
export type DeletePolicyRuleRequest = z.infer<typeof DeletePolicyRuleRequest>;

export const PolicyRulesResponse = z.object({ rules: z.array(PolicyRuleSummary) });
export type PolicyRulesResponse = z.infer<typeof PolicyRulesResponse>;

export const PolicyRuleResponse = z.object({ rule: PolicyRuleSummary });
export type PolicyRuleResponse = z.infer<typeof PolicyRuleResponse>;
