import { PermissionAction } from '@knoverge/contracts';
import type {
  MembershipRole,
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
  holdsAction,
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

/** Every action the permission model defines, in a stable order. */
const ALL_PERMISSION_ACTIONS: readonly PermissionAction[] = PermissionAction.options;

/** How long the same refusal is recorded only once. */
export const DENIAL_REPEAT_MS = 60_000;

/** Upper bound on the refusals tracked at once, so the map cannot grow without limit. */
const MAX_TRACKED_DENIALS = 10_000;

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
  private readonly recentDenials = new Map<string, number>();

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

  /**
   * Whether the actor may use an endpoint that lists things. The results are
   * filtered afterwards with filter(), so a branch-scoped grant shows that
   * branch instead of refusing the whole listing.
   */
  async mayList(
    actor: ActorContext,
    standing: ActorStanding,
    action: PermissionAction,
  ): Promise<boolean> {
    if (actor.actorType === 'system') return true;
    return holdsAction(await this.grantsFor(actor, standing), action);
  }

  /** Keeps the items the actor may see for this action. */
  async filter<T>(
    actor: ActorContext,
    standing: ActorStanding,
    action: PermissionAction,
    items: readonly T[],
    toTarget: (item: T) => Target,
  ): Promise<T[]> {
    const ancestorsOf = await this.ancestorsOf(actor.workspaceId);
    const grants = await this.grantsFor(actor, standing);
    return items.filter(
      (item) => evaluatePermission(grants, action, toTarget(item), ancestorsOf).allowed,
    );
  }

  /**
   * The first action in the list the actor does not hold anywhere, or null when
   * it holds all of them. Authority is handed out, never invented: whenever a
   * call would give somebody a set of permissions at once (a membership role or
   * an agent's trust tier), the caller must already hold every action in it.
   */
  /**
   * Every action the actor holds somewhere in this workspace.
   *
   * The web interface shows and hides controls from this, so that what it
   * offers and what the server allows are one answer rather than two.
   */
  async heldActions(actor: ActorContext, standing: ActorStanding): Promise<PermissionAction[]> {
    if (actor.actorType === 'system') return [...ALL_PERMISSION_ACTIONS];
    const grants = await this.grantsFor(actor, standing);
    return ALL_PERMISSION_ACTIONS.filter((action) => holdsAction(grants, action));
  }

  async missingAction(
    actor: ActorContext,
    standing: ActorStanding,
    actions: readonly PermissionAction[],
  ): Promise<PermissionAction | null> {
    // The system actor is the host operator running the command line, who owns
    // the database and the secrets. Nothing here could constrain them, and
    // pretending otherwise would only break the documented recovery path.
    if (actor.actorType === 'system') return null;
    const grants = await this.grantsFor(actor, standing);
    return actions.find((action) => !holdsAction(grants, action)) ?? null;
  }

  private async grantsFor(actor: ActorContext, standing: ActorStanding): Promise<Grant[]> {
    const stored = await this.o.grants.listForActor(actor.workspaceId, actor.actorId);
    // For an agent, an explicit allow replaces the tier baseline for that
    // action, which is how an agent is restricted to one branch. A person's
    // role is the statement of their authority and is never replaced: someone
    // else's grant must not be able to take away what a role confers. Narrowing
    // a person's access is what a deny grant is for.
    const narrowed =
      standing.role === undefined
        ? new Set(stored.filter((g) => g.effect === 'allow').map((g) => g.action))
        : new Set<string>();
    return [
      ...this.implicitGrants(actor, standing).filter((g) => !narrowed.has(g.action)),
      ...stored.map<Grant>((g) => ({
        id: g.id,
        actorId: g.actorId,
        action: g.action,
        scope: g.scope,
        effect: g.effect,
      })),
    ];
  }

  async check(
    actor: ActorContext,
    standing: ActorStanding,
    action: PermissionAction,
    target: Target = {},
  ): Promise<AuthorizationDecision> {
    // Same rule as missingAction: the system actor is the host operator running
    // the command line, who owns the database and the secrets. The two used to
    // disagree, so a command line path that happened to reach check() instead
    // would have been refused, taking the documented recovery route with it.
    if (actor.actorType === 'system') return { allowed: true, reason: 'system_actor' };
    const ancestorsOf = await this.ancestorsOf(actor.workspaceId);
    const grants = await this.grantsFor(actor, standing);
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

  /**
   * Records a refused command. Denied commands never become proposals.
   *
   * Repeats within a short window are dropped. A caller that loops on an
   * endpoint it may not use would otherwise write one append-only event per
   * request into a table nothing may prune, and take the workspace's ledger
   * lock each time, serialising every real write behind it. The first refusal
   * of each kind is what the audit needs; the rest are the same fact again.
   */
  async recordDenied(
    actor: ActorContext,
    action: string,
    reason: string,
    target: Target = {},
  ): Promise<void> {
    if (this.repeatedDenial(actor, action, reason)) return;
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

  /**
   * True when this actor was already refused the same thing recently. The
   * window is per process and deliberately short: two processes may each record
   * one refusal, which is a far better trade than an unbounded write path.
   */
  private repeatedDenial(actor: ActorContext, action: string, reason: string): boolean {
    const now = Date.now();
    const key = `${actor.workspaceId}|${actor.actorId}|${action}|${reason}`;
    const last = this.recentDenials.get(key);
    if (last !== undefined && now - last < DENIAL_REPEAT_MS) return true;
    if (this.recentDenials.size >= MAX_TRACKED_DENIALS) {
      for (const [k, at] of this.recentDenials) {
        if (now - at >= DENIAL_REPEAT_MS) this.recentDenials.delete(k);
      }
      // Still full of live entries: forget the oldest rather than grow.
      if (this.recentDenials.size >= MAX_TRACKED_DENIALS) {
        const oldest = this.recentDenials.keys().next();
        if (!oldest.done) this.recentDenials.delete(oldest.value);
      }
    }
    this.recentDenials.set(key, now);
    return false;
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
