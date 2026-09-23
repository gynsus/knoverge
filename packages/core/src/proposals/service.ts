import type {
  CategoryId,
  EventType,
  PolicyActionName,
  PolicyEffect,
  FrontmatterRelation,
  FrontmatterSource,
  ItemType,
  KnowledgeItemId,
  ProposalId,
  ProposalType,
  ReviewState,
  RevisionId,
  WorkspaceId,
} from '@knoverge/contracts';

import type { ActorContext } from '../actor-context.ts';
import type { ActorStanding, AuthorizationService } from '../authorization/service.ts';
import { DomainError } from '../errors.ts';
import { newId } from '../ids.ts';
import type { DuplicateMatcher } from '../knowledge/duplicates.ts';
import type {
  CreateItemInput,
  DeleteItemInput,
  ItemResult,
  KnowledgeService,
  SupersedeInput,
  UpdateItemInput,
} from '../knowledge/service.ts';
import type { EventLedger } from '../ledger/ledger.ts';
import type { Clock } from '../ports/clock.ts';
import { systemClock } from '../ports/clock.ts';
import type { Tx, UnitOfWork } from '../ports/unit-of-work.ts';
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
  /** What the workspace may already hold, checked before anything is recorded. */
  duplicates: DuplicateMatcher;
  actors: ActorRepository;
  ledger: EventLedger;
  clock?: Clock;
}

export interface ProposeCreateInput extends CreateItemInput {
  reason?: string | undefined;
  confidence?: number | undefined;
  /** Candidates the proposer has read and ruled out. */
  acknowledgedDuplicateIds?: readonly string[] | undefined;
  /** The reconciliation pass this came out of, so a run can be read as one. */
  syncSessionId?: string | undefined;
}

export interface ProposeUpdateInput extends UpdateItemInput {
  reason?: string | undefined;
  confidence?: number | undefined;
}

export interface ProposeDeleteInput extends DeleteItemInput {
  reason?: string | undefined;
  confidence?: number | undefined;
}

export interface ProposeCategoryInput {
  name: string;
  parentPath?: string | undefined;
  parentId?: string | undefined;
  description?: string | undefined;
  reason?: string | undefined;
  /** What would go in it, which is how a reviewer judges whether it is needed. */
  exampleTitles?: readonly string[] | undefined;
}

export interface ProposeSupersedeInput extends SupersedeInput {
  reason?: string | undefined;
  confidence?: number | undefined;
}

/** A supersede proposal's payload: what replaces the item, and from when. */
interface ProposedSupersedePayload {
  validUntil?: string | null;
  newItem?: ProposedCreatePayload;
  existingItem?: { itemId: KnowledgeItemId; baseRevisionId: RevisionId; baseContentHash: string };
}

/** The stored payload of an update proposal: only the fields that were given. */
interface ProposedUpdatePayload {
  title: string;
  body: string;
  type: ItemType;
  language: string;
  categories: string[];
  tags: string[];
  sources: FrontmatterSource[];
  relations: FrontmatterRelation[];
  validFrom: string | null;
  validUntil: string | null;
  observedAt: string | null;
}

/** A policy answer that is not a refusal, and the rule that gave it. */
type PolicyDecision = { effect: Exclude<PolicyEffect, 'deny'>; ruleId?: string | undefined };

/**
 * What applying a proposal produced.
 *
 * A supersession produces two revisions from one operation, so this is a list
 * rather than one revision, and the item is the one the proposal was about.
 */
interface AppliedWrite {
  itemId: KnowledgeItemId;
  revisionIds: RevisionId[];
}

/** One proposal to record, whichever kind it is. */
interface RecordSpec {
  proposalType: ProposalType;
  decision: PolicyDecision;
  payload: Record<string, unknown>;
  targetItemId: KnowledgeItemId | null;
  baseRevisionId: RevisionId | null;
  baseContentHash: string | null;
  reason?: string | undefined;
  confidence?: number | undefined;
  eventType: EventType;
  /** Checked before a pending proposal is recorded, when the kind has any. */
  relations?: readonly FrontmatterRelation[] | undefined;
  /** What the proposer read and ruled out, kept for whoever reviews it. */
  acknowledgedDuplicateIds?: readonly string[] | undefined;
  /** The reconciliation pass this came out of, so a run can be read as one. */
  syncSessionId?: string | undefined;
  /** What `allow_direct` runs, and what approval runs later. */
  apply: (proposalId: ProposalId) => Promise<AppliedWrite>;
}

/** What a failed approval means the workspace did without this proposal. */
const MOVED_ON = new Set<string>([
  'REVISION_CONFLICT',
  'DUPLICATE_SUSPECTED',
  'DUPLICATE_EXTERNAL_KEY',
]);

/** One write of one revision, in the shape the proposal machinery expects. */
async function applied(write: Promise<ItemResult>): Promise<AppliedWrite> {
  const result = await write;
  return { itemId: result.item.id, revisionIds: [result.revision.id] };
}

/**
 * Rule 6, for a proposal.
 *
 * A proposer that read an older revision is told now. The same check runs
 * again when the proposal is approved, because the item can move on while the
 * proposal waits.
 */
function assertBase(current: ItemResult, revisionId: RevisionId, contentHash: string): void {
  if (current.revision.id === revisionId && current.revision.contentHash === contentHash) return;
  throw new DomainError(
    'REVISION_CONFLICT',
    'the item changed since you read it; re-read it and propose your change against the current revision',
    {
      objectIds: {
        knowledge_item: current.item.id,
        current_revision_id: current.revision.id,
        current_content_hash: current.revision.contentHash,
      },
    },
  );
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
    const categoryIds = await this.categoryIds(actor.workspaceId, input.categories ?? []);
    const decision = await this.decide(actor, standing, 'knowledge.create', {
      categoryIds,
      type: input.type,
    });

    // Before anything is recorded, and before policy's answer matters: a
    // newly connected agent must not fill the workspace with what it already
    // holds, whether the write would have waited for review or not.
    await this.o.duplicates.assertNotDuplicate({
      workspaceId: actor.workspaceId,
      title: input.title,
      body: input.body,
      type: input.type,
      categoryIds: categoryIds as CategoryId[],
      external: input.external,
      acknowledged: input.acknowledgedDuplicateIds,
    });

    return this.record(actor, {
      proposalType: 'knowledge_create',
      decision,
      payload: {
        title: input.title,
        body: input.body,
        type: input.type,
        language: input.language ?? null,
        categories: [...(input.categories ?? [])],
        tags: [...(input.tags ?? [])],
        sources: [...(input.sources ?? [])],
        relations: [...(input.relations ?? [])],
      },
      targetItemId: null,
      baseRevisionId: null,
      baseContentHash: null,
      reason: input.reason,
      confidence: input.confidence,
      eventType: 'knowledge.proposed_create',
      relations: input.relations ?? [],
      acknowledgedDuplicateIds: input.acknowledgedDuplicateIds ?? [],
      ...(input.syncSessionId ? { syncSessionId: input.syncSessionId } : {}),
      apply: (proposalId) => applied(this.o.knowledge.create(actor, { ...input, proposalId })),
    });
  }

  /**
   * Proposing a change to an item that already exists.
   *
   * Rule 6 applies to a proposal exactly as it applies to a write. The base is
   * checked here, so a proposer built on a stale read is told now rather than
   * after a reviewer has spent attention on it, and again when the proposal is
   * approved, because the item can move on while the proposal waits.
   */
  async proposeUpdate(
    actor: ActorContext,
    standing: ActorStanding,
    input: ProposeUpdateInput,
  ): Promise<ProposalOutcome> {
    await this.o.authorization.require(actor, standing, 'knowledge.propose_update');
    const current = await this.o.knowledge.get(actor, input.itemId);
    assertBase(current, input.baseRevisionId, input.baseContentHash);

    const decision = await this.decide(actor, standing, 'knowledge.update', {
      // The categories it would end up in, which is what a scoped rule is
      // about; an update that moves an item is decided where it is going.
      categoryIds: await this.categoryIds(
        actor.workspaceId,
        input.categories ?? current.categories,
      ),
      type: input.type ?? current.item.type,
    });

    const payload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries({
      title: input.title,
      body: input.body,
      type: input.type,
      language: input.language,
      categories: input.categories ? [...input.categories] : undefined,
      tags: input.tags ? [...input.tags] : undefined,
      sources: input.sources ? [...input.sources] : undefined,
      relations: input.relations ? [...input.relations] : undefined,
      validFrom: input.validFrom,
      validUntil: input.validUntil,
      observedAt: input.observedAt,
    })) {
      // A field left out is left alone, so only what was given is stored.
      if (value !== undefined) payload[key] = value;
    }

    return this.record(actor, {
      proposalType: 'knowledge_update',
      decision,
      payload,
      targetItemId: input.itemId,
      baseRevisionId: input.baseRevisionId,
      baseContentHash: input.baseContentHash,
      reason: input.reason,
      confidence: input.confidence,
      eventType: 'knowledge.proposed_update',
      apply: (proposalId) =>
        applied(
          this.o.knowledge.update(actor, {
            ...this.updateInput(payload),
            itemId: input.itemId,
            baseRevisionId: input.baseRevisionId,
            baseContentHash: input.baseContentHash,
            proposalId,
          }),
        ),
    });
  }

  /**
   * Proposing that one item replace another.
   *
   * The proposal is about the item being superseded — that is what it acts on,
   * what it carries a base for, and what other pending proposals conflict
   * with. Approving it runs the same atomic operation a person runs: one
   * commit, two revisions, no half-applied supersession.
   */
  async proposeSupersede(
    actor: ActorContext,
    standing: ActorStanding,
    input: ProposeSupersedeInput,
  ): Promise<ProposalOutcome> {
    await this.o.authorization.require(actor, standing, 'knowledge.propose_supersede');
    const current = await this.o.knowledge.get(actor, input.oldItemId);
    assertBase(current, input.oldBaseRevisionId, input.oldBaseContentHash);

    const decision = await this.decide(actor, standing, 'knowledge.supersede', {
      categoryIds: await this.categoryIds(
        actor.workspaceId,
        input.newItem?.categories ?? current.categories,
      ),
      type: input.newItem?.type ?? current.item.type,
    });

    const payload: Record<string, unknown> = {
      ...(input.validUntil !== undefined ? { validUntil: input.validUntil } : {}),
      ...(input.newItem
        ? {
            newItem: {
              title: input.newItem.title,
              body: input.newItem.body,
              type: input.newItem.type,
              language: input.newItem.language ?? null,
              categories: [...(input.newItem.categories ?? [])],
              tags: [...(input.newItem.tags ?? [])],
              sources: [...(input.newItem.sources ?? [])],
              relations: [...(input.newItem.relations ?? [])],
            },
          }
        : {}),
      ...(input.existingItem
        ? {
            existingItem: {
              itemId: input.existingItem.itemId,
              baseRevisionId: input.existingItem.baseRevisionId,
              baseContentHash: input.existingItem.baseContentHash,
            },
          }
        : {}),
    };

    return this.record(actor, {
      proposalType: 'knowledge_supersede',
      decision,
      payload,
      targetItemId: input.oldItemId,
      baseRevisionId: input.oldBaseRevisionId,
      baseContentHash: input.oldBaseContentHash,
      reason: input.reason,
      confidence: input.confidence,
      eventType: 'knowledge.proposed_supersede',
      relations: input.newItem?.relations ?? [],
      apply: async (proposalId) => {
        const result = await this.o.knowledge.supersede(actor, {
          oldItemId: input.oldItemId,
          oldBaseRevisionId: input.oldBaseRevisionId,
          oldBaseContentHash: input.oldBaseContentHash,
          ...(input.validUntil !== undefined ? { validUntil: input.validUntil } : {}),
          ...(input.newItem ? { newItem: input.newItem } : {}),
          ...(input.existingItem ? { existingItem: input.existingItem } : {}),
          proposalId,
        });
        return {
          itemId: input.oldItemId,
          revisionIds: [result.new.revision.id, result.old.revision.id],
        };
      },
    });
  }

  /**
   * Proposing a category.
   *
   * A taxonomy proposal carries no knowledge, so there is nothing to apply
   * and nothing to conflict with: it is a question for a person, recorded so
   * they can answer it. Approving one is the taxonomy service's own create,
   * which the review workflow reaches in a later milestone; until then a
   * reviewer reads the proposal and makes the category themselves.
   */
  async proposeCategory(
    actor: ActorContext,
    standing: ActorStanding,
    input: ProposeCategoryInput,
  ): Promise<ProposalRecord> {
    await this.o.authorization.require(actor, standing, 'taxonomy.propose');
    const now = this.clock.now();
    const proposal: ProposalRecord = {
      id: newId('prop') as ProposalId,
      workspaceId: actor.workspaceId,
      proposalType: 'category_create',
      targetItemId: null,
      targetCategoryId: (input.parentId ?? null) as CategoryId | null,
      status: 'pending',
      proposedByActorId: actor.actorId,
      baseRevisionId: null,
      baseContentHash: null,
      proposedPayload: {
        name: input.name,
        parentPath: input.parentPath ?? null,
        description: input.description ?? null,
        exampleTitles: [...(input.exampleTitles ?? [])],
      },
      reason: input.reason ?? null,
      confidence: null,
      acknowledgedDuplicateIds: [],
      syncSessionId: null,
      policyDecision: 'require_review',
      policyRuleId: null,
      createdAt: now,
      resolvedAt: null,
      resolvedByActorId: null,
      resolutionNote: null,
      resultRevisionIds: [],
    };
    await this.o.uow.run(async (tx) => {
      await this.o.proposals.insert(tx, proposal);
      await this.o.ledger.append(tx, actor.workspaceId, actor, {
        eventType: 'category.proposed',
        objectType: 'proposal',
        objectId: proposal.id,
        ...(input.parentId ? { categoryIds: [input.parentId] } : {}),
        metadata: { proposal_type: 'category_create', policy_decision: 'require_review' },
      });
    });
    return proposal;
  }

  /** Proposing that an item leave the current index. The history keeps it. */
  async proposeDelete(
    actor: ActorContext,
    standing: ActorStanding,
    input: ProposeDeleteInput,
  ): Promise<ProposalOutcome> {
    await this.o.authorization.require(actor, standing, 'knowledge.propose_delete');
    const current = await this.o.knowledge.get(actor, input.itemId);
    assertBase(current, input.baseRevisionId, input.baseContentHash);

    const decision = await this.decide(actor, standing, 'knowledge.delete', {
      categoryIds: await this.categoryIds(actor.workspaceId, current.categories),
      type: current.item.type,
    });

    return this.record(actor, {
      proposalType: 'knowledge_delete',
      decision,
      // Nothing to carry: a delete proposes no content, only that this
      // revision of this item should go.
      payload: {},
      targetItemId: input.itemId,
      baseRevisionId: input.baseRevisionId,
      baseContentHash: input.baseContentHash,
      reason: input.reason,
      confidence: input.confidence,
      eventType: 'knowledge.proposed_delete',
      apply: (proposalId) =>
        applied(
          this.o.knowledge.delete(actor, {
            itemId: input.itemId,
            baseRevisionId: input.baseRevisionId,
            baseContentHash: input.baseContentHash,
            proposalId,
          }),
        ),
    });
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
    const edits = nonEmpty(input.edits);
    const payload = this.payloadFor(proposal, edits);
    const now = this.clock.now();
    const review = actor.actorType === 'human' ? 'human_reviewed' : 'agent_reviewed';
    let result: AppliedWrite;
    try {
      await this.assertStillDistinct(actor, proposal, payload);
      result = await this.applyOnApproval(actor, proposal, payload, review);
    } catch (error) {
      // The workspace moved past this proposal while it waited — a direct
      // write, another proposal approved first, or the same text arriving by
      // some other route. Leaving it pending would put it back in the inbox
      // to fail the same way for the next reviewer.
      if (error instanceof DomainError && MOVED_ON.has(error.code)) {
        await this.o.uow.run((tx) => this.markConflict(tx, actor, proposal));
      }
      throw error;
    }

    const patch: ProposalPatch = {
      status: edits ? 'approved_with_edits' : 'approved',
      resolvedAt: now,
      resolvedByActorId: actor.actorId,
      resolutionNote: input.note ?? null,
      resultRevisionIds: result.revisionIds,
      // What was approved, which is not what was proposed when a reviewer
      // changed it. Keeping only the original would leave the trail claiming
      // the proposer wrote text they never saw.
      ...(edits ? { proposedPayload: payload } : {}),
    };
    // Every other pending proposal against this item was written against the
    // revision that is no longer current, so the first approval wins and the
    // rest need rebasing (KNOWLEDGE_LIFECYCLE.md section 3).
    const about = proposal.targetItemId ?? result.itemId;
    const stale = await this.o.proposals.list(actor.workspaceId, {
      targetItemId: about,
      status: 'pending',
    });
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
          knowledge_item: about,
          revisions: result.revisionIds.join(' '),
        },
      });
      for (const other of stale) {
        if (other.id === proposal.id) continue;
        await this.markConflict(tx, actor, other);
      }
    });
    return {
      proposal: { ...proposal, ...patch, targetItemId: about } as ProposalRecord,
      itemId: result.itemId,
    };
  }

  /**
   * That the workspace still does not hold this, at the moment of approving.
   *
   * Only the kinds that write something new: an update or a delete is about an
   * item that exists, and its base check is what guards it. Approving two
   * identical create proposals in a row produced two identical items, because
   * the duplicate check ran when each was proposed and never again.
   */
  private async assertStillDistinct(
    actor: ActorContext,
    proposal: ProposalRecord,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const content =
      proposal.proposalType === 'knowledge_create'
        ? (payload as unknown as ProposedCreatePayload)
        : proposal.proposalType === 'knowledge_supersede'
          ? (payload as ProposedSupersedePayload).newItem
          : undefined;
    if (!content) return;
    await this.o.duplicates.assertStillDistinct({
      workspaceId: actor.workspaceId,
      title: content.title,
      body: content.body,
      type: content.type,
      categoryIds: (await this.categoryIds(actor.workspaceId, content.categories)) as CategoryId[],
      acknowledged: proposal.acknowledgedDuplicateIds,
    });
  }

  /**
   * What approval writes, which is what the proposal asked for.
   *
   * A create makes an item, an update changes one, a delete retires one. Each
   * carries the base the proposer read: `knowledge.update` and
   * `knowledge.delete` check it again and answer `REVISION_CONFLICT` if the
   * item moved on while the proposal waited, which is the second half of rule
   * 6 and the reason a stale proposal cannot be approved by accident.
   */
  private async applyOnApproval(
    actor: ActorContext,
    proposal: ProposalRecord,
    payload: Record<string, unknown>,
    review: ReviewState,
  ): Promise<AppliedWrite> {
    if (proposal.proposalType === 'knowledge_create') {
      const p = payload as unknown as ProposedCreatePayload;
      return applied(
        this.o.knowledge.create(actor, {
          title: p.title,
          body: p.body,
          type: p.type,
          ...(p.language ? { language: p.language } : {}),
          categories: p.categories,
          tags: p.tags,
          sources: p.sources,
          relations: p.relations,
          proposalId: proposal.id,
          review,
        }),
      );
    }
    const itemId = proposal.targetItemId;
    const baseRevisionId = proposal.baseRevisionId;
    const baseContentHash = proposal.baseContentHash;
    if (!itemId || !baseRevisionId || !baseContentHash) {
      throw new DomainError('INTERNAL_ERROR', 'the proposal names no item to change', {
        objectIds: { proposal: proposal.id },
      });
    }
    if (proposal.proposalType === 'knowledge_update') {
      return applied(
        this.o.knowledge.update(actor, {
          ...this.updateInput(payload),
          itemId,
          baseRevisionId,
          baseContentHash,
          proposalId: proposal.id,
          review,
        }),
      );
    }
    if (proposal.proposalType === 'knowledge_delete') {
      return applied(
        this.o.knowledge.delete(actor, {
          itemId,
          baseRevisionId,
          baseContentHash,
          proposalId: proposal.id,
        }),
      );
    }
    if (proposal.proposalType === 'knowledge_supersede') {
      const result = await this.o.knowledge.supersede(actor, {
        ...this.supersedeInput(payload),
        oldItemId: itemId,
        oldBaseRevisionId: baseRevisionId,
        oldBaseContentHash: baseContentHash,
        proposalId: proposal.id,
        review,
      });
      // Two revisions from one operation, and the item the proposal was about
      // is the one that was superseded.
      return { itemId, revisionIds: [result.new.revision.id, result.old.revision.id] };
    }
    // Supersession and category proposals arrive with the proposals that
    // produce them; refusing beats applying a payload this cannot read.
    throw new DomainError(
      'VALIDATION_ERROR',
      `approving a ${proposal.proposalType} proposal arrives in a later milestone`,
      { objectIds: { proposal: proposal.id } },
    );
  }

  /** The proposal's payload with the reviewer's changes folded in. */
  private payloadFor(
    proposal: ProposalRecord,
    edits: ProposalEditsInput | undefined,
  ): Record<string, unknown> {
    if (!edits) return proposal.proposedPayload;
    if (proposal.proposalType === 'knowledge_delete') {
      // There is nothing to edit: a delete proposes no content. A reviewer who
      // wants different content rejects it and writes what they want.
      throw new DomainError('VALIDATION_ERROR', 'a delete proposal carries nothing to edit', {
        objectIds: { proposal: proposal.id },
      });
    }
    const given = Object.fromEntries(
      Object.entries(edits).filter(([, value]) => value !== undefined),
    );
    if (proposal.proposalType === 'knowledge_supersede') {
      const p = proposal.proposedPayload as ProposedSupersedePayload;
      if (!p.newItem) {
        // The replacement already exists and has its own text, its own
        // history and its own reviewers. Editing it here would change an item
        // the proposal only pointed at.
        throw new DomainError(
          'VALIDATION_ERROR',
          'this supersession replaces with an item that already exists; edit that item instead',
          { objectIds: { proposal: proposal.id } },
        );
      }
      return { ...proposal.proposedPayload, newItem: { ...p.newItem, ...given } };
    }
    return { ...proposal.proposedPayload, ...given };
  }

  /**
   * A proposal the workspace moved past.
   *
   * Not rejected: nobody decided against it, and the difference matters to
   * whoever proposed it. A reviewer can rebase it onto the current revision.
   */
  private async markConflict(tx: Tx, actor: ActorContext, proposal: ProposalRecord): Promise<void> {
    await this.o.proposals.update(tx, actor.workspaceId, proposal.id, {
      status: 'conflict',
      resolvedAt: this.clock.now(),
      resolvedByActorId: actor.actorId,
      resolutionNote: 'the item changed while this proposal was waiting',
    });
    await this.o.ledger.append(tx, actor.workspaceId, actor, {
      eventType: 'proposal.conflict',
      objectType: 'proposal',
      objectId: proposal.id,
      metadata: {
        proposal_type: proposal.proposalType,
        proposed_by: proposal.proposedByActorId,
        ...(proposal.targetItemId ? { knowledge_item: proposal.targetItemId } : {}),
      },
    });
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

  /**
   * Permission and policy, in that order.
   *
   * The permission says whether this actor may ask at all; the policy says
   * what happens to the asking. A denial is not recorded as a proposal —
   * there was nothing for anybody to decide, and `command.denied` is the
   * record of it (rule 14).
   */
  private async decide(
    actor: ActorContext,
    standing: ActorStanding,
    action: PolicyActionName,
    target: { categoryIds: string[]; type: ItemType },
  ): Promise<PolicyDecision> {
    const decision = await this.o.authorization.policyDecisionFor(actor, standing, action, target);
    if (decision.effect === 'deny') {
      await this.o.authorization.recordDenied(actor, action, 'policy_deny', target);
      throw new DomainError('FORBIDDEN', 'policy refuses this write');
    }
    return { effect: decision.effect, ruleId: decision.ruleId };
  }

  /**
   * Turning a decision into either a change or something to review.
   *
   * Both outcomes leave a proposal row. One that policy allowed directly is
   * stored already approved and resolved by the system actor, so the trail
   * reads the same whether a person looked at it or a rule did, and a reviewer
   * coming back later can see why nobody was asked.
   */
  private async record(actor: ActorContext, spec: RecordSpec): Promise<ProposalOutcome> {
    const now = this.clock.now();
    const proposalId = newId('prop') as ProposalId;
    const base: Omit<ProposalRecord, 'status' | 'policyDecision'> = {
      id: proposalId,
      workspaceId: actor.workspaceId,
      proposalType: spec.proposalType,
      targetItemId: spec.targetItemId,
      targetCategoryId: null,
      proposedByActorId: actor.actorId,
      baseRevisionId: spec.baseRevisionId,
      baseContentHash: spec.baseContentHash,
      proposedPayload: spec.payload,
      reason: spec.reason ?? null,
      confidence: spec.confidence ?? null,
      acknowledgedDuplicateIds: [...(spec.acknowledgedDuplicateIds ?? [])],
      syncSessionId: spec.syncSessionId ?? null,
      policyRuleId: spec.decision.ruleId ?? null,
      createdAt: now,
      resolvedAt: null,
      resolvedByActorId: null,
      resolutionNote: null,
      resultRevisionIds: [],
    };

    if (spec.decision.effect === 'require_review') {
      // The direct path validates these inside the write. Review has no such
      // moment, so a proposal naming an item that does not exist would sit in
      // the inbox until somebody approved it and it failed there.
      if (spec.relations) {
        await this.o.knowledge.assertRelationTargetsExist(actor.workspaceId, spec.relations);
      }
      const proposal: ProposalRecord = {
        ...base,
        status: 'pending',
        policyDecision: 'require_review',
      };
      await this.o.uow.run(async (tx) => {
        await this.o.proposals.insert(tx, proposal);
        await this.o.ledger.append(tx, actor.workspaceId, actor, {
          eventType: spec.eventType,
          objectType: 'proposal',
          objectId: proposalId,
          // No title and no body: the payload is in the proposal row, which
          // purge can redact. The ledger cannot be redacted, so it holds ids.
          metadata: {
            proposal_type: spec.proposalType,
            policy_decision: 'require_review',
            ...(spec.targetItemId ? { knowledge_item: spec.targetItemId } : {}),
            ...(spec.decision.ruleId ? { policy_rule: spec.decision.ruleId } : {}),
          },
        });
      });
      return { proposal, itemId: null };
    }

    // allow_direct: the write happens now, and the proposal records that it
    // did and on whose authority.
    const result = await spec.apply(proposalId);
    const system = await this.o.actors.findSystemActor(actor.workspaceId);
    const proposal: ProposalRecord = {
      ...base,
      // A create learns its item only by making it; every other kind named
      // the item it was about before anything was written.
      targetItemId: spec.targetItemId ?? result.itemId,
      status: 'approved',
      policyDecision: 'allow_direct',
      resolvedAt: now,
      // The rule approved it, not a person. The system actor is who a rule is.
      resolvedByActorId: system?.id ?? actor.actorId,
      resultRevisionIds: result.revisionIds,
    };
    await this.o.uow.run((tx) => this.o.proposals.insert(tx, proposal));
    return { proposal, itemId: result.itemId };
  }

  /** The stored payload of a supersede proposal, as `knowledge.supersede` takes it. */
  private supersedeInput(
    payload: Record<string, unknown>,
  ): Pick<SupersedeInput, 'validUntil' | 'newItem' | 'existingItem'> {
    const p = payload as ProposedSupersedePayload;
    return {
      ...(p.validUntil !== undefined ? { validUntil: p.validUntil } : {}),
      ...(p.newItem
        ? {
            newItem: {
              title: p.newItem.title,
              body: p.newItem.body,
              type: p.newItem.type,
              ...(p.newItem.language ? { language: p.newItem.language } : {}),
              categories: p.newItem.categories,
              tags: p.newItem.tags,
              sources: p.newItem.sources,
              relations: p.newItem.relations,
            },
          }
        : {}),
      ...(p.existingItem ? { existingItem: p.existingItem } : {}),
    };
  }

  /** The stored payload of an update proposal, as `knowledge.update` takes it. */
  private updateInput(payload: Record<string, unknown>): Partial<UpdateItemInput> {
    const p = payload as Partial<ProposedUpdatePayload>;
    return {
      ...(p.title !== undefined ? { title: p.title } : {}),
      ...(p.body !== undefined ? { body: p.body } : {}),
      ...(p.type !== undefined ? { type: p.type } : {}),
      ...(p.language !== undefined ? { language: p.language } : {}),
      ...(p.categories !== undefined ? { categories: p.categories } : {}),
      ...(p.tags !== undefined ? { tags: p.tags } : {}),
      ...(p.sources !== undefined ? { sources: p.sources } : {}),
      ...(p.relations !== undefined ? { relations: p.relations } : {}),
      ...(p.validFrom !== undefined ? { validFrom: p.validFrom } : {}),
      ...(p.validUntil !== undefined ? { validUntil: p.validUntil } : {}),
      ...(p.observedAt !== undefined ? { observedAt: p.observedAt } : {}),
    };
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
