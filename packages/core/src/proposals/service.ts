import type { KnowledgeItemId, ProposalId, WorkspaceId } from '@knoverge/contracts';

import type { ActorContext } from '../actor-context.ts';
import type { ActorStanding, AuthorizationService } from '../authorization/service.ts';
import { DomainError } from '../errors.ts';
import { newId } from '../ids.ts';
import type { CreateItemInput, KnowledgeService } from '../knowledge/service.ts';
import type { EventLedger } from '../ledger/ledger.ts';
import type { Clock } from '../ports/clock.ts';
import { systemClock } from '../ports/clock.ts';
import type { UnitOfWork } from '../ports/unit-of-work.ts';
import type { CategoryRepository } from '../taxonomy/repository.ts';
import type { ActorRepository } from '../workspace/repository.ts';
import type { ProposalRecord, ProposalRepository } from './repository.ts';

export interface ProposalServiceOptions {
  uow: UnitOfWork;
  proposals: ProposalRepository;
  knowledge: KnowledgeService;
  /** Category paths become ids before policy sees them (rule 13). */
  categories: CategoryRepository;
  authorization: AuthorizationService;
  actors: ActorRepository;
  ledger: EventLedger;
  clock?: Clock;
}

export interface ProposeCreateInput extends CreateItemInput {
  reason?: string | undefined;
  confidence?: number | undefined;
}

export interface ProposalOutcome {
  proposal: ProposalRecord;
  /** The item, when policy let the proposal through and it was applied. */
  itemId: KnowledgeItemId | null;
}

/**
 * Proposals: how an agent contributes, and how a workspace decides.
 *
 * Rule 5 gives an agent read, search and propose by default. Rule 14 says a
 * write still waits for review unless a policy rule says otherwise, including
 * for a trusted agent. Both of those meet here, and this is the only place
 * that turns a request into either a change or a thing somebody has to look
 * at.
 *
 * A proposal is recorded either way. One that policy allowed directly is
 * stored already approved and resolved by the system actor, so the trail reads
 * the same whether a person looked at it or a rule did, and a reviewer coming
 * back later can see why nobody was asked. A denial is not recorded as a
 * proposal at all: there was nothing to decide, and the `command.denied` event
 * is the record of it.
 */
export class ProposalService {
  private readonly o: ProposalServiceOptions;
  private readonly clock: Clock;

  constructor(options: ProposalServiceOptions) {
    this.o = options;
    this.clock = options.clock ?? systemClock;
  }

  async proposeCreate(
    actor: ActorContext,
    standing: ActorStanding,
    input: ProposeCreateInput,
  ): Promise<ProposalOutcome> {
    // Permission first: whether the caller may ask at all. The policy decides
    // what happens to the asking, which is a different question — an actor can
    // hold knowledge.propose_create and still have every proposal reviewed.
    await this.o.authorization.require(actor, standing, 'knowledge.propose_create');

    // The categories the item is aimed at, as ids: a rule may allow direct
    // writes into one part of the tree and not another, and a path is a
    // portable identifier rather than a security one (rule 13).
    const target = {
      categoryIds: await this.categoryIds(actor.workspaceId, input.categories ?? []),
      type: input.type,
    };
    const decision = await this.o.authorization.policyDecisionFor(
      actor,
      standing,
      'knowledge.create',
      target,
    );
    if (decision.effect === 'deny') {
      // No proposal: there is nothing for anybody to review. The denial is
      // recorded as a command.denied event, which is the record of it.
      await this.o.authorization.recordDenied(actor, 'knowledge.create', 'policy_deny', target);
      throw new DomainError('FORBIDDEN', 'policy refuses this write');
    }

    const now = this.clock.now();
    const proposalId = newId('prop') as ProposalId;
    const payload = {
      title: input.title,
      body: input.body,
      type: input.type,
      language: input.language ?? null,
      categories: [...(input.categories ?? [])],
      tags: [...(input.tags ?? [])],
      sources: [...(input.sources ?? [])],
      relations: [...(input.relations ?? [])],
    };

    if (decision.effect === 'require_review') {
      // The direct path validates these inside knowledge.create. Review has no
      // such moment, so a proposal naming an item that does not exist would sit
      // in the inbox until somebody approved it and it failed there.
      await this.o.knowledge.assertRelationTargetsExist(actor.workspaceId, input.relations ?? []);
      const proposal: ProposalRecord = {
        id: proposalId,
        workspaceId: actor.workspaceId,
        proposalType: 'knowledge_create',
        targetItemId: null,
        targetCategoryId: null,
        status: 'pending',
        proposedByActorId: actor.actorId,
        baseRevisionId: null,
        baseContentHash: null,
        proposedPayload: payload,
        reason: input.reason ?? null,
        confidence: input.confidence ?? null,
        acknowledgedDuplicateIds: [],
        syncSessionId: null,
        policyDecision: 'require_review',
        policyRuleId: decision.ruleId ?? null,
        createdAt: now,
        resolvedAt: null,
        resolvedByActorId: null,
        resolutionNote: null,
        resultRevisionIds: [],
      };
      await this.o.uow.run(async (tx) => {
        await this.o.proposals.insert(tx, proposal);
        await this.o.ledger.append(tx, actor.workspaceId, actor, {
          eventType: 'knowledge.proposed_create',
          objectType: 'proposal',
          objectId: proposalId,
          // No title and no body: the payload is in the proposal row, which
          // purge can redact. The ledger cannot be redacted, so it holds ids.
          metadata: {
            proposal_type: 'knowledge_create',
            policy_decision: 'require_review',
            ...(decision.ruleId ? { policy_rule: decision.ruleId } : {}),
          },
        });
      });
      return { proposal, itemId: null };
    }

    // allow_direct: the write happens now, and the proposal records that it
    // did and on whose authority.
    const result = await this.o.knowledge.create(actor, input);
    const system = await this.o.actors.findSystemActor(actor.workspaceId);
    const proposal: ProposalRecord = {
      id: proposalId,
      workspaceId: actor.workspaceId,
      proposalType: 'knowledge_create',
      targetItemId: result.item.id,
      targetCategoryId: null,
      status: 'approved',
      proposedByActorId: actor.actorId,
      baseRevisionId: null,
      baseContentHash: null,
      proposedPayload: payload,
      reason: input.reason ?? null,
      confidence: input.confidence ?? null,
      acknowledgedDuplicateIds: [],
      syncSessionId: null,
      policyDecision: 'allow_direct',
      policyRuleId: decision.ruleId ?? null,
      createdAt: now,
      resolvedAt: now,
      // The rule approved it, not a person. The system actor is who a rule is.
      resolvedByActorId: system?.id ?? actor.actorId,
      resolutionNote: null,
      resultRevisionIds: [result.revision.id],
    };
    await this.o.uow.run((tx) => this.o.proposals.insert(tx, proposal));
    return { proposal, itemId: result.item.id };
  }

  /** Paths to ids, refusing one the workspace does not have. */
  private async categoryIds(workspaceId: WorkspaceId, paths: readonly string[]): Promise<string[]> {
    if (paths.length === 0) return [];
    const tree = await this.o.categories.list(workspaceId, { includeArchived: true });
    return paths.map((path) => {
      const category = tree.find((c) => c.path === path);
      if (!category) {
        throw new DomainError('NOT_FOUND', `no category at ${path}`, { objectIds: { path } });
      }
      return category.id;
    });
  }

  list(
    workspaceId: WorkspaceId,
    options: Parameters<ProposalRepository['list']>[1] = {},
  ): Promise<ProposalRecord[]> {
    return this.o.proposals.list(workspaceId, options);
  }

  async get(workspaceId: WorkspaceId, id: ProposalId): Promise<ProposalRecord> {
    const proposal = await this.o.proposals.findById(workspaceId, id);
    if (!proposal) {
      throw new DomainError('NOT_FOUND', 'proposal not found', { objectIds: { proposal: id } });
    }
    return proposal;
  }
}
