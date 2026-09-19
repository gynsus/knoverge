import type {
  ActorId,
  PermissionAction,
  PermissionEffect,
  PolicyActionName,
  PolicyEffect,
  PolicySubject,
  ScopeSelector,
  ScopeSelectorInput,
} from '@knoverge/contracts';
import { EMPTY_SCOPE, ROLE_PERMISSIONS } from '@knoverge/policy';

import type { ActorContext } from '../actor-context.ts';
import type { MembershipRepository } from '../identity/repository.ts';
import type { ActorRepository } from '../workspace/repository.ts';
import type { ActorStanding, AuthorizationService } from './service.ts';
import { DomainError } from '../errors.ts';
import { newId } from '../ids.ts';
import type { EventLedger } from '../ledger/ledger.ts';
import type { Clock } from '../ports/clock.ts';
import { systemClock } from '../ports/clock.ts';
import type { UnitOfWork } from '../ports/unit-of-work.ts';
import type { CategoryRepository } from '../taxonomy/repository.ts';
import type {
  PermissionGrantRecord,
  PermissionGrantRepository,
  PolicyRuleRecord,
  PolicyRuleRepository,
} from './repository.ts';

export interface AuthorizationAdminOptions {
  uow: UnitOfWork;
  grants: PermissionGrantRepository;
  rules: PolicyRuleRepository;
  categories: CategoryRepository;
  actors: ActorRepository;
  memberships: MembershipRepository;
  authorization: AuthorizationService;
  ledger: EventLedger;
  clock?: Clock;
}

/**
 * Actions that administer the installation itself. An agent is automation acting
 * for a person; giving it these would let one administrator hand workspace
 * control to a credential they hold, outside the membership model.
 */
const HUMAN_ONLY_ACTIONS: ReadonlySet<PermissionAction> = new Set([
  'workspace.admin',
  'policy.manage',
  'agent.manage',
]);

export interface GrantInput {
  actorId: ActorId;
  action: PermissionAction;
  effect: PermissionEffect;
  scope?: ScopeSelectorInput | undefined;
}

export interface RuleInput {
  ruleId?: string | undefined;
  priority: number;
  subject: PolicySubject;
  action: PolicyActionName;
  scope?: ScopeSelectorInput | undefined;
  effect: PolicyEffect;
  enabled: boolean;
}

/** Administration of permission grants and policy rules. */
export class AuthorizationAdminService {
  private readonly o: AuthorizationAdminOptions;
  private readonly clock: Clock;

  constructor(options: AuthorizationAdminOptions) {
    this.o = options;
    this.clock = options.clock ?? systemClock;
  }

  listGrants(actor: ActorContext, actorId?: ActorId) {
    return actorId
      ? this.o.grants.listForActor(actor.workspaceId, actorId)
      : this.o.grants.list(actor.workspaceId);
  }

  listRules(actor: ActorContext) {
    return this.o.rules.list(actor.workspaceId);
  }

  async grant(
    actor: ActorContext,
    standing: ActorStanding,
    input: GrantInput,
  ): Promise<PermissionGrantRecord> {
    const subject = await this.o.actors.findById(actor.workspaceId, input.actorId);
    if (!subject) {
      throw new DomainError('NOT_FOUND', 'actor not found in this workspace', {
        objectIds: { actor_id: input.actorId },
      });
    }
    const scope = await this.validateScope(actor, input.scope);
    if (input.effect === 'allow') {
      // Nobody hands out more than they hold, so policy.manage cannot be used to
      // widen one's own role or to build a more privileged actor.
      await this.assertAuthorityCovers(actor, standing, input.action, scope);
      if (subject.type === 'agent' && HUMAN_ONLY_ACTIONS.has(input.action)) {
        throw new DomainError('FORBIDDEN', `${input.action} cannot be granted to an agent`);
      }
      await this.refuseConfusingScope(actor, subject, input);
    }
    // A restriction on you is somebody else's to place and somebody else's to
    // lift. Denying yourself would otherwise be a one-way door: revoking needs
    // the action the deny just took away, and nobody else can revoke it for you.
    if (input.effect === 'deny' && input.actorId === actor.actorId) {
      throw new DomainError('FORBIDDEN', 'you cannot restrict yourself; ask another administrator');
    }
    const record: PermissionGrantRecord = {
      id: newId('grant'),
      workspaceId: actor.workspaceId,
      actorId: input.actorId,
      action: input.action,
      scope,
      effect: input.effect,
      createdByActorId: actor.actorId,
      createdAt: this.clock.now(),
    };
    await this.o.uow.run(async (tx) => {
      await this.o.grants.insert(tx, record);
      await this.o.ledger.append(tx, actor.workspaceId, actor, {
        eventType: 'permission.granted',
        objectType: 'permission',
        objectId: record.id,
        metadata: {
          subject_actor_id: record.actorId,
          action: record.action,
          effect: record.effect,
          scope_categories: scope.categories.map((c) => c.category_id),
        },
      });
    });
    return record;
  }

  /**
   * Removing a grant changes authority as much as adding one: taking away a
   * deny restores what it restricted. So the same rule applies in both
   * directions, and neither end of it may be skipped.
   */
  async revokeGrant(actor: ActorContext, standing: ActorStanding, grantId: string): Promise<void> {
    const grant = await this.o.grants.findById(actor.workspaceId, grantId);
    if (!grant) throw new DomainError('NOT_FOUND', 'permission grant not found');
    // Nobody lifts a restriction placed on themselves, however narrow it is.
    if (grant.effect === 'deny' && grant.actorId === actor.actorId) {
      throw new DomainError(
        'FORBIDDEN',
        'this grant restricts you, so somebody else has to remove it',
      );
    }
    const held = await this.o.authorization.check(actor, standing, grant.action);
    if (!held.allowed) {
      throw new DomainError(
        'FORBIDDEN',
        `you do not hold ${grant.action}, so you cannot revoke a grant for it`,
      );
    }
    await this.o.uow.run(async (tx) => {
      const removed = await this.o.grants.delete(tx, actor.workspaceId, grantId);
      if (!removed) throw new DomainError('NOT_FOUND', 'permission grant not found');
      await this.o.ledger.append(tx, actor.workspaceId, actor, {
        eventType: 'permission.revoked',
        objectType: 'permission',
        objectId: grantId,
        metadata: {
          subject_actor_id: removed.actorId,
          action: removed.action,
          effect: removed.effect,
        },
      });
    });
  }

  async upsertRule(
    actor: ActorContext,
    standing: ActorStanding,
    input: RuleInput,
  ): Promise<PolicyRuleRecord> {
    const scope = await this.validateScope(actor, input.scope);
    // A rule that applies a write directly decides in advance what a reviewer
    // would otherwise decide case by case, so writing one is approval.
    if (input.effect === 'allow_direct') await this.assertMayLoosenPolicy(actor, standing);
    if (input.ruleId) {
      const before = await this.o.rules.findById(actor.workspaceId, input.ruleId);
      // Turning a deny off, or turning it into something weaker, loosens policy
      // exactly as deleting it would.
      if (before?.effect === 'deny' && (input.effect !== 'deny' || !input.enabled)) {
        await this.assertMayLoosenPolicy(actor, standing);
      }
    }
    if ('actor_id' in input.subject) {
      const subject = await this.o.actors.findById(actor.workspaceId, input.subject.actor_id);
      if (!subject) {
        throw new DomainError('NOT_FOUND', 'actor not found in this workspace', {
          objectIds: { actor_id: input.subject.actor_id },
        });
      }
    }
    const now = this.clock.now();
    const existing = input.ruleId
      ? await this.o.rules.findById(actor.workspaceId, input.ruleId)
      : null;
    if (input.ruleId && !existing) throw new DomainError('NOT_FOUND', 'policy rule not found');
    const record: PolicyRuleRecord = {
      id: existing?.id ?? newId('rule'),
      workspaceId: actor.workspaceId,
      priority: input.priority,
      subject: input.subject,
      action: input.action,
      scope,
      effect: input.effect,
      enabled: input.enabled,
      createdByActorId: existing?.createdByActorId ?? actor.actorId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await this.o.uow.run(async (tx) => {
      await this.o.rules.upsert(tx, record);
      await this.o.ledger.append(tx, actor.workspaceId, actor, {
        eventType: 'policy.rule_changed',
        objectType: 'policy_rule',
        objectId: record.id,
        metadata: {
          change: existing ? 'updated' : 'created',
          action: record.action,
          effect: record.effect,
          priority: record.priority,
          enabled: record.enabled,
        },
      });
    });
    return record;
  }

  /**
   * Removing a rule changes policy as much as writing one: deleting a deny can
   * expose a lower-priority allow_direct underneath it, and disabling one has
   * the same effect. Both therefore take the standing that writing an
   * allow_direct takes.
   */
  async deleteRule(actor: ActorContext, standing: ActorStanding, ruleId: string): Promise<void> {
    const rule = await this.o.rules.findById(actor.workspaceId, ruleId);
    if (!rule) throw new DomainError('NOT_FOUND', 'policy rule not found');
    if (rule.effect === 'deny') await this.assertMayLoosenPolicy(actor, standing);
    await this.o.uow.run(async (tx) => {
      const removed = await this.o.rules.delete(tx, actor.workspaceId, ruleId);
      if (!removed) throw new DomainError('NOT_FOUND', 'policy rule not found');
      await this.o.ledger.append(tx, actor.workspaceId, actor, {
        eventType: 'policy.rule_changed',
        objectType: 'policy_rule',
        objectId: ruleId,
        metadata: { change: 'deleted', action: removed.action, effect: removed.effect },
      });
    });
  }

  /**
   * Anything that lets a write happen without a reviewer is approval given in
   * advance, so it takes the power to approve.
   */
  private async assertMayLoosenPolicy(actor: ActorContext, standing: ActorStanding): Promise<void> {
    const missing = await this.o.authorization.missingAction(actor, standing, [
      'knowledge.approve',
    ]);
    if (missing) {
      throw new DomainError(
        'FORBIDDEN',
        'this decides in advance what a reviewer would decide, so it needs knowledge.approve',
      );
    }
  }

  /**
   * The granter must hold the action at least as widely as the grant gives it.
   *
   * Checking with no target answers "do you hold this anywhere", which a scoped
   * deny never matches. An administrator restricted to one branch was therefore
   * judged to hold the action workspace-wide, and could hand it out unscoped to
   * an agent it created and then act through that agent's token. The
   * restriction was not lifted; it was walked around.
   */
  private async assertAuthorityCovers(
    actor: ActorContext,
    standing: ActorStanding,
    action: PermissionAction,
    scope: ScopeSelector,
  ): Promise<void> {
    const refuse = (why: string): never => {
      throw new DomainError('FORBIDDEN', why);
    };
    if (scope.categories.length > 0) {
      // A branch-scoped grant needs authority over each branch it names.
      for (const entry of scope.categories) {
        const held = await this.o.authorization.check(actor, standing, action, {
          categoryIds: [entry.category_id],
        });
        if (!held.allowed) {
          refuse(`you do not hold ${action} for every category in this scope`);
        }
      }
      return;
    }
    const held = await this.o.authorization.check(actor, standing, action);
    if (!held.allowed) {
      refuse(`you do not hold ${action}, so you cannot grant it`);
    }
    // An unscoped grant gives the action everywhere, so anything that restricts
    // the granter anywhere is enough to refuse it.
    const restricted = (await this.o.grants.listForActor(actor.workspaceId, actor.actorId)).some(
      (g) => g.effect === 'deny' && g.action === action,
    );
    if (restricted) {
      refuse(
        `${action} is restricted for you, so you cannot grant it without the same restriction`,
      );
    }
  }

  /**
   * A scoped allow narrows an agent but does nothing to a person, whose role
   * already carries the action. Refusing it is clearer than storing a grant
   * that has no effect, and points at the deny grant that does restrict.
   */
  private async refuseConfusingScope(
    actor: ActorContext,
    subject: { type: string; userId: string | null },
    input: GrantInput,
  ): Promise<void> {
    const scoped =
      (input.scope?.categories.length ?? 0) > 0 ||
      (input.scope?.types.length ?? 0) > 0 ||
      (input.scope?.languages.length ?? 0) > 0;
    if (!scoped || subject.type !== 'human' || subject.userId === null) return;
    const membership = await this.o.memberships.find(actor.workspaceId, subject.userId as never);
    if (membership && ROLE_PERMISSIONS[membership.role].includes(input.action)) {
      throw new DomainError(
        'VALIDATION_ERROR',
        `the ${membership.role} role already allows ${input.action} everywhere; use a deny grant to restrict it`,
      );
    }
  }

  /** Rejects scopes that name categories from another workspace or none at all. */
  private async validateScope(
    actor: ActorContext,
    scope: ScopeSelectorInput | undefined,
  ): Promise<ScopeSelector> {
    if (!scope) return EMPTY_SCOPE;
    const categories: ScopeSelector['categories'] = [];
    for (const entry of scope.categories) {
      // A path is resolved here and never stored: what is compared is the id,
      // so a rename or a move cannot detach a grant from what it covers.
      const category = entry.category_id
        ? await this.o.categories.findById(actor.workspaceId, entry.category_id)
        : await this.o.categories.findByPath(actor.workspaceId, entry.category_path as string);
      if (!category) {
        const named = entry.category_id ?? entry.category_path ?? '';
        throw new DomainError('NOT_FOUND', `unknown category in scope: ${named}`, {
          objectIds: entry.category_id
            ? { category_id: entry.category_id }
            : { path: entry.category_path ?? null },
        });
      }
      categories.push({
        category_id: category.id,
        include_descendants: entry.include_descendants,
      });
    }
    return { categories, types: scope.types, languages: scope.languages };
  }
}
