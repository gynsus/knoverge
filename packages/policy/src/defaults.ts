import type {
  MembershipRole,
  PermissionAction,
  PolicyEffect,
  TrustTier,
} from '@knoverge/contracts';

/**
 * Permissions installed with a new agent, by trust tier (SECURITY.md section 7).
 * A tier decides what may be attempted; an explicit policy rule decides whether
 * a write happens directly.
 */
export const TIER_PERMISSIONS: Record<TrustTier, readonly PermissionAction[]> = {
  read_only: ['taxonomy.read', 'knowledge.read', 'knowledge.search', 'events.read_own'],
  propose: [
    'taxonomy.read',
    'taxonomy.propose',
    'knowledge.read',
    'knowledge.read_history',
    'knowledge.search',
    'knowledge.propose_create',
    'knowledge.propose_update',
    'knowledge.propose_delete',
    'knowledge.propose_supersede',
    'proposal.read_own',
    'events.read_own',
  ],
  trusted: [
    'taxonomy.read',
    'taxonomy.propose',
    'knowledge.read',
    'knowledge.read_history',
    'knowledge.search',
    'knowledge.propose_create',
    'knowledge.propose_update',
    'knowledge.propose_delete',
    'knowledge.propose_supersede',
    'knowledge.write',
    'proposal.read_own',
    'events.read_own',
  ],
};

/**
 * Policy fallback when no rule matches. Every agent, including a trusted one,
 * requires review until a scoped rule says otherwise, so a misconfigured tier
 * fails safe.
 */
export const TIER_POLICY_DEFAULT: Record<TrustTier, PolicyEffect> = {
  read_only: 'deny',
  propose: 'require_review',
  trusted: 'require_review',
};

/** Permissions a human holds implicitly through a workspace membership. */
export const ROLE_PERMISSIONS: Record<MembershipRole, readonly PermissionAction[]> = {
  viewer: [
    'taxonomy.read',
    'knowledge.read',
    'knowledge.read_history',
    'knowledge.search',
    'proposal.read_own',
    'events.read_own',
  ],
  reviewer: [
    'taxonomy.read',
    'taxonomy.propose',
    'knowledge.read',
    'knowledge.read_history',
    'knowledge.search',
    'knowledge.propose_create',
    'knowledge.propose_update',
    'knowledge.propose_delete',
    'knowledge.propose_supersede',
    'knowledge.write',
    'knowledge.approve',
    'proposal.read_all',
    'proposal.read_own',
    'events.read_all',
    'events.read_own',
  ],
  admin: [
    'taxonomy.read',
    'taxonomy.propose',
    'taxonomy.manage',
    'knowledge.read',
    'knowledge.read_history',
    'knowledge.search',
    'knowledge.propose_create',
    'knowledge.propose_update',
    'knowledge.propose_delete',
    'knowledge.propose_supersede',
    'knowledge.write',
    'knowledge.approve',
    'proposal.read_all',
    'proposal.read_own',
    'events.read_all',
    'events.read_own',
    'agent.manage',
    'policy.manage',
  ],
  owner: [
    'taxonomy.read',
    'taxonomy.propose',
    'taxonomy.manage',
    'knowledge.read',
    'knowledge.read_history',
    'knowledge.search',
    'knowledge.propose_create',
    'knowledge.propose_update',
    'knowledge.propose_delete',
    'knowledge.propose_supersede',
    'knowledge.write',
    'knowledge.approve',
    'proposal.read_all',
    'proposal.read_own',
    'events.read_all',
    'events.read_own',
    'agent.manage',
    'policy.manage',
    'workspace.admin',
  ],
};

export const ROLE_POLICY_DEFAULT: Record<MembershipRole, PolicyEffect> = {
  viewer: 'deny',
  reviewer: 'allow_direct',
  admin: 'allow_direct',
  owner: 'allow_direct',
};
