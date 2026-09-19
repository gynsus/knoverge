import type {
  ActorId,
  PermissionAction,
  PermissionEffect,
  PolicyActionName,
  PolicyEffect,
  PolicySubject,
  ScopeSelector,
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
  scope?: ScopeSelector | undefined;
}

export interface RuleInput {
  ruleId?: string | undefined;
  priority: number;
  subject: PolicySubject;
  action: PolicyActionName;
  scope?: ScopeSelector | undefined;
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
      const held = await this.o.authorization.check(actor, standing, input.action);
      if (!held.allowed) {
        throw new DomainError(
          'FORBIDDEN',
          `you do not hold ${input.action}, so you cannot grant it`,
        );
      }
      if (subject.type === 'agent' && HUMAN_ONLY_ACTIONS.has(input.action)) {
        throw new DomainError('FORBIDDEN', `${input.action} cannot be granted to an agent`);
      }
      await this.refuseConfusingScope(actor, subject, input);
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

  async revokeGrant(actor: ActorContext, grantId: string): Promise<void> {
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

  async upsertRule(actor: ActorContext, input: RuleInput): Promise<PolicyRuleRecord> {
    const scope = await this.validateScope(actor, input.scope);
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

  async deleteRule(actor: ActorContext, ruleId: string): Promise<void> {
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
    scope: ScopeSelector | undefined,
  ): Promise<ScopeSelector> {
    if (!scope) return EMPTY_SCOPE;
    for (const entry of scope.categories) {
      const category = await this.o.categories.findById(actor.workspaceId, entry.category_id);
      if (!category) {
        throw new DomainError('NOT_FOUND', `unknown category in scope: ${entry.category_id}`, {
          objectIds: { category_id: entry.category_id },
        });
      }
    }
    return scope;
  }
}
