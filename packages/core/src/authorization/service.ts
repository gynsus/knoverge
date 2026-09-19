import type {
  MembershipRole,
  PermissionAction,
  PolicyActionName,
  PolicyEffect,
  TrustTier,
  WorkspaceId,
} from '@knoverge/contracts';
import {
  EMPTY_SCOPE,
  ROLE_PERMISSIONS,
  ROLE_POLICY_DEFAULT,
  TIER_PERMISSIONS,
  TIER_POLICY_DEFAULT,
  evaluatePermission,
  evaluatePolicy,
  type CategoryAncestors,
  type Grant,
  type Target,
} from '@knoverge/policy';

import type { ActorContext } from '../actor-context.ts';
import { DomainError } from '../errors.ts';
import type { EventLedger } from '../ledger/ledger.ts';
import type { UnitOfWork } from '../ports/unit-of-work.ts';
import type { CategoryRepository } from '../taxonomy/repository.ts';
import type { PermissionGrantRepository, PolicyRuleRepository } from './repository.ts';

/** What the caller holds beyond explicit grants. */
export interface ActorStanding {
  role?: MembershipRole | undefined;
  trustTier?: TrustTier | undefined;
}

export interface AuthorizationServiceOptions {
  uow: UnitOfWork;
  grants: PermissionGrantRepository;
  rules: PolicyRuleRepository;
  categories: CategoryRepository;
  ledger: EventLedger;
}

export interface AuthorizationDecision {
  allowed: boolean;
  reason: string;
  grantId?: string;
}

/**
 * Permission and policy decisions (SECURITY.md sections 7 to 9).
 *
 * A human's role and an agent's trust tier grant a baseline set of permissions.
 * Stored grants add to that baseline, and an explicit deny beats everything,
 * so a narrow deny can carve an exception out of a role.
 */
export class AuthorizationService {
  private readonly o: AuthorizationServiceOptions;

  constructor(options: AuthorizationServiceOptions) {
    this.o = options;
  }

  /**
   * Builds an ancestor lookup from the workspace's category paths.
   *
   * This reads the workspace's categories once per call. Taxonomies are tens to
   * hundreds of rows, so the query is cheap; if it ever stops being cheap, cache
   * it by taxonomy version rather than by time, because a stale ancestor map
   * would decide permissions from an outdated tree.
   */
  async ancestorsOf(workspaceId: WorkspaceId): Promise<CategoryAncestors> {
    const categories = await this.o.categories.list(workspaceId, { includeArchived: true });
    const byPath = new Map(categories.map((c) => [c.path, c.id as string]));
    const cache = new Map<string, string[]>();
    for (const category of categories) {
      const segments = category.path.split('/');
      const ancestors: string[] = [];
      for (let i = 1; i < segments.length; i += 1) {
        const id = byPath.get(segments.slice(0, i).join('/'));
        if (id) ancestors.push(id);
      }
      cache.set(category.id, ancestors);
    }
    return (categoryId: string) => cache.get(categoryId) ?? [];
  }

  async check(
    actor: ActorContext,
    standing: ActorStanding,
    action: PermissionAction,
    target: Target = {},
  ): Promise<AuthorizationDecision> {
    const ancestorsOf = await this.ancestorsOf(actor.workspaceId);
    const stored = await this.o.grants.listForActor(actor.workspaceId, actor.actorId);
    const implicit = this.implicitGrants(actor, standing);
    const grants: Grant[] = [
      ...implicit,
      ...stored.map<Grant>((g) => ({
        id: g.id,
        actorId: g.actorId,
        action: g.action,
        scope: g.scope,
        effect: g.effect,
      })),
    ];
    const decision = evaluatePermission(grants, action, target, ancestorsOf);
    return {
      allowed: decision.allowed,
      reason: decision.reason,
      ...(decision.grantId ? { grantId: decision.grantId } : {}),
    };
  }

  /**
   * Throws FORBIDDEN and records command.denied when the action is not allowed.
   */
  async require(
    actor: ActorContext,
    standing: ActorStanding,
    action: PermissionAction,
    target: Target = {},
  ): Promise<void> {
    const decision = await this.check(actor, standing, action, target);
    if (decision.allowed) return;
    await this.recordDenied(actor, action, decision.reason, target);
    throw new DomainError('FORBIDDEN', `not permitted: ${action}`);
  }

  /** Decides how a permitted write is applied: directly, after review, or not at all. */
  async policyFor(
    actor: ActorContext,
    standing: ActorStanding,
    action: PolicyActionName,
    target: Target = {},
  ): Promise<PolicyEffect> {
    const ancestorsOf = await this.ancestorsOf(actor.workspaceId);
    const rules = await this.o.rules.list(actor.workspaceId);
    const fallback = this.defaultEffect(actor, standing);
    const decision = evaluatePolicy(
      rules.map((r) => ({
        id: r.id,
        priority: r.priority,
        subject: r.subject,
        action: r.action,
        scope: r.scope,
        effect: r.effect,
        enabled: r.enabled,
      })),
      {
        actorId: actor.actorId,
        actorType: actor.actorType,
        ...(standing.trustTier ? { trustTier: standing.trustTier } : {}),
      },
      action,
      target,
      fallback,
      ancestorsOf,
    );
    return decision.effect;
  }

  /** Records a refused command. Denied commands never become proposals. */
  async recordDenied(
    actor: ActorContext,
    action: string,
    reason: string,
    target: Target = {},
  ): Promise<void> {
    await this.o.uow.run((tx) =>
      this.o.ledger.append(tx, actor.workspaceId, actor, {
        eventType: 'command.denied',
        objectType: 'command',
        objectId: action,
        ...(target.categoryIds ? { categoryIds: target.categoryIds } : {}),
        metadata: {
          action,
          reason,
          ...(target.type ? { type: target.type } : {}),
        },
      }),
    );
  }

  private implicitGrants(actor: ActorContext, standing: ActorStanding): Grant[] {
    const actions =
      standing.role !== undefined
        ? ROLE_PERMISSIONS[standing.role]
        : standing.trustTier !== undefined
          ? TIER_PERMISSIONS[standing.trustTier]
          : [];
    return actions.map<Grant>((action) => ({
      id: `implicit:${action}`,
      actorId: actor.actorId,
      action,
      scope: EMPTY_SCOPE,
      effect: 'allow',
    }));
  }

  private defaultEffect(actor: ActorContext, standing: ActorStanding): PolicyEffect {
    if (standing.role !== undefined) return ROLE_POLICY_DEFAULT[standing.role];
    if (standing.trustTier !== undefined) return TIER_POLICY_DEFAULT[standing.trustTier];
    // A system actor acts on the operator's behalf from the host.
    return actor.actorType === 'system' ? 'allow_direct' : 'deny';
  }
}
