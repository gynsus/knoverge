import type {
  FrontmatterRelation,
  FrontmatterSource,
  ItemType,
  KnowledgeItemId,
  ProposalId,
  WorkspaceId,
} from '@knoverge/contracts';

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
import type { ProposalPatch, ProposalRecord, ProposalRepository } from './repository.ts';

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

/** What a reviewer may change before approving: the content and nothing else. */
export interface ProposalEditsInput {
  title?: string | undefined;
  body?: string | undefined;
  type?: ItemType | undefined;
  language?: string | undefined;
  categories?: readonly string[] | undefined;
  tags?: readonly string[] | undefined;
  sources?: readonly FrontmatterSource[] | undefined;
  relations?: readonly FrontmatterRelation[] | undefined;
}

export interface ApproveProposalInput {
  proposalId: ProposalId;
  edits?: ProposalEditsInput | undefined;
  note?: string | undefined;
}

export interface ResolveProposalInput {
  proposalId: ProposalId;
  reason?: string | undefined;
}

/** A create proposal's payload, as `proposeCreate` stored it. */
interface ProposedCreatePayload {
  title: string;
  body: string;
  type: ItemType;
  language: string | null;
  categories: string[];
  tags: string[];
  sources: FrontmatterSource[];
  relations: FrontmatterRelation[];
}

/**
 * Edits a reviewer actually made.
 *
 * An empty object is not an edit, and treating one as such would record
 * `approved_with_edits` for a reviewer who changed nothing.
 */
function nonEmpty(edits: ProposalEditsInput | undefined): ProposalEditsInput | undefined {
  if (!edits) return undefined;
  const given = Object.entries(edits).filter(([, value]) => value !== undefined);
  return given.length > 0 ? (Object.fromEntries(given) as ProposalEditsInput) : undefined;
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

  /**
   * Making a pending proposal canonical.
   *
   * Two authorities meet and both are needed: `knowledge.approve` says the
   * caller may decide, and the policy that sent the proposal to review has
   * already had its say. An actor never approves its own proposal, whoever
   * they are — the point of review is a second pair of eyes, and an owner
   * approving their own agent's work through a shared actor would defeat it.
   *
   * The reviewer is the actor of the resulting write: they are who made it
   * canonical, and the commit carries `Knoverge-Proposal` so the repository
   * alone leads back to the proposer. Who approved sets the review state, as
   * `KNOWLEDGE_LIFECYCLE.md` section 4 requires: a person makes it
   * `human_reviewed`, an agent `agent_reviewed`.
   */
  async approve(
    actor: ActorContext,
    standing: ActorStanding,
    input: ApproveProposalInput,
  ): Promise<ProposalOutcome> {
    await this.o.authorization.require(actor, standing, 'knowledge.approve');
    const proposal = await this.pendingFor(actor.workspaceId, input.proposalId);
    if (proposal.proposedByActorId === actor.actorId) {
      throw new DomainError('FORBIDDEN', 'an actor cannot approve its own proposal', {
        objectIds: { proposal: proposal.id },
      });
    }
    if (proposal.proposalType !== 'knowledge_create') {
      // The other kinds arrive with the proposals that produce them; refusing
      // is better than applying a payload this code does not understand.
      throw new DomainError(
        'VALIDATION_ERROR',
        `approving a ${proposal.proposalType} proposal arrives in a later milestone`,
        { objectIds: { proposal: proposal.id } },
      );
    }

    const edits = nonEmpty(input.edits);
    const stored = proposal.proposedPayload as unknown as ProposedCreatePayload;
    const payload: ProposedCreatePayload = {
      title: edits?.title ?? stored.title,
      body: edits?.body ?? stored.body,
      type: edits?.type ?? stored.type,
      language: edits?.language ?? stored.language,
      categories: [...(edits?.categories ?? stored.categories)],
      tags: [...(edits?.tags ?? stored.tags)],
      sources: [...(edits?.sources ?? stored.sources)],
      relations: [...(edits?.relations ?? stored.relations)],
    };
    const now = this.clock.now();
    const result = await this.o.knowledge.create(actor, {
      title: payload.title,
      body: payload.body,
      type: payload.type,
      ...(payload.language ? { language: payload.language } : {}),
      categories: payload.categories,
      tags: payload.tags,
      sources: payload.sources,
      relations: payload.relations,
      proposalId: proposal.id,
      review: actor.actorType === 'human' ? 'human_reviewed' : 'agent_reviewed',
    });

    const patch: ProposalPatch = {
      status: edits ? 'approved_with_edits' : 'approved',
      resolvedAt: now,
      resolvedByActorId: actor.actorId,
      resolutionNote: input.note ?? null,
      resultRevisionIds: [result.revision.id],
      // What was approved, which is not what was proposed when a reviewer
      // changed it. Keeping only the original would leave the trail claiming
      // the proposer wrote text they never saw.
      ...(edits ? { proposedPayload: payload as unknown as Record<string, unknown> } : {}),
    };
    await this.o.uow.run(async (tx) => {
      await this.o.proposals.update(tx, actor.workspaceId, proposal.id, patch);
      await this.o.ledger.append(tx, actor.workspaceId, actor, {
        eventType: edits ? 'proposal.edited_and_approved' : 'proposal.approved',
        objectType: 'proposal',
        objectId: proposal.id,
        metadata: {
          proposal_type: proposal.proposalType,
          // Both actors, which is what section 4 asks the ledger to record:
          // the reviewer is the actor of the event, the proposer is here.
          proposed_by: proposal.proposedByActorId,
          knowledge_item: result.item.id,
          revision: result.revision.id,
        },
      });
    });
    return {
      proposal: { ...proposal, ...patch, targetItemId: result.item.id } as ProposalRecord,
      itemId: result.item.id,
    };
  }

  /**
   * Saying no, and saying why.
   *
   * The proposal stays: `KNOWLEDGE_LIFECYCLE.md` section 4 keeps a rejection in
   * the audit history, and a proposer that cannot see it was refused would
   * propose the same thing again. Nothing is written to Git — there was
   * nothing to write.
   */
  async reject(
    actor: ActorContext,
    standing: ActorStanding,
    input: ResolveProposalInput,
  ): Promise<ProposalRecord> {
    await this.o.authorization.require(actor, standing, 'knowledge.approve');
    const proposal = await this.pendingFor(actor.workspaceId, input.proposalId);
    if (proposal.proposedByActorId === actor.actorId) {
      throw new DomainError('FORBIDDEN', 'an actor cannot review its own proposal', {
        objectIds: { proposal: proposal.id },
      });
    }
    return this.resolve(actor, proposal, 'rejected', 'proposal.rejected', input.reason);
  }

  /**
   * Taking a proposal back.
   *
   * The proposer may, because it is their proposal and they have learned it is
   * not worth deciding. A reviewer may, because an inbox nobody can clear is
   * an inbox nobody reads. Anybody else may not, which is why this checks the
   * actor rather than a permission alone.
   */
  async withdraw(
    actor: ActorContext,
    standing: ActorStanding,
    input: ResolveProposalInput,
  ): Promise<ProposalRecord> {
    const proposal = await this.pendingFor(actor.workspaceId, input.proposalId);
    if (proposal.proposedByActorId !== actor.actorId) {
      await this.o.authorization.require(actor, standing, 'knowledge.approve');
    }
    return this.resolve(actor, proposal, 'withdrawn', 'proposal.withdrawn', input.reason);
  }

  /** The shared tail of rejecting and withdrawing: no write, one row, one event. */
  private async resolve(
    actor: ActorContext,
    proposal: ProposalRecord,
    status: 'rejected' | 'withdrawn',
    eventType: 'proposal.rejected' | 'proposal.withdrawn',
    reason: string | undefined,
  ): Promise<ProposalRecord> {
    const patch: ProposalPatch = {
      status,
      resolvedAt: this.clock.now(),
      resolvedByActorId: actor.actorId,
      resolutionNote: reason ?? null,
      resultRevisionIds: [],
    };
    await this.o.uow.run(async (tx) => {
      await this.o.proposals.update(tx, actor.workspaceId, proposal.id, patch);
      await this.o.ledger.append(tx, actor.workspaceId, actor, {
        eventType,
        objectType: 'proposal',
        objectId: proposal.id,
        metadata: {
          proposal_type: proposal.proposalType,
          proposed_by: proposal.proposedByActorId,
        },
      });
    });
    return { ...proposal, ...patch } as ProposalRecord;
  }

  /** A proposal that still has a decision left in it. */
  private async pendingFor(workspaceId: WorkspaceId, id: ProposalId): Promise<ProposalRecord> {
    const proposal = await this.get(workspaceId, id);
    if (proposal.status !== 'pending') {
      throw new DomainError('PROPOSAL_ALREADY_RESOLVED', `this proposal is ${proposal.status}`, {
        objectIds: { proposal: id, status: proposal.status },
      });
    }
    return proposal;
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
