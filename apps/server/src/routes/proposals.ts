import {
  ProposalGetInput,
  ProposalListInput,
  ProposalResponse,
  ProposalsResponse,
  ProposedContent,
  ProposedSupersedePayload,
  type ProposalSummary,
} from '@knoverge/contracts';
import type {
  ApproveProposalRequest,
  ProposalResult,
  ProposeCreateRequest,
  ProposeDeleteRequest,
  ProposeSupersedeRequest,
  ProposeUpdateRequest,
  RejectProposalRequest,
  WithdrawProposalRequest,
} from '@knoverge/contracts';
import { DomainError, type ProposalEditsInput, type ProposalRecord } from '@knoverge/core';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import { idempotencyKey, resolveWorkspaceActor } from '../plugins/actor-context.ts';
import { changeInput, contentInput, proposalExtras } from './knowledge-input.ts';
import type { Services } from '../services.ts';

/**
 * What a proposal says about the item it would write.
 *
 * A create carries the content at the top level and a supersession under
 * `new_item`; an update carries only the fields it changes; a delete and a
 * category proposal carry nothing of the sort, and a resolved proposal's payload
 * may have been emptied by maintenance. All of those answer an empty content
 * rather than an error: this names a row in a queue.
 */
function proposedContent(proposal: ProposalRecord): ProposedContent {
  if (proposal.proposalType === 'knowledge_supersede') {
    const parsed = ProposedSupersedePayload.safeParse(proposal.proposedPayload);
    return parsed.success ? (parsed.data.new_item ?? {}) : {};
  }
  const parsed = ProposedContent.safeParse(proposal.proposedPayload);
  return parsed.success ? parsed.data : {};
}

/**
 * The title a proposal proposes, when its payload carries one.
 *
 * An update carries it only when it is changing it, and a delete never; those
 * are named by the item they are about instead.
 */
export function proposedTitle(proposal: ProposalRecord): string | null {
  return proposedContent(proposal).title ?? null;
}

/** Where the proposal says it belongs, read the same way its title is. */
function proposedCategories(proposal: ProposalRecord): string[] {
  return [...(proposedContent(proposal).categories ?? [])];
}

/**
 * A reviewer's edits, in the domain's own names.
 *
 * Named field by field: the wire speaks snake_case and the domain speaks
 * camelCase, and handing one straight to the other worked only for the fields
 * whose names happen to match. It stopped working the moment a validity window
 * could be edited, and would have dropped it without a word.
 */
function editsFor(edits: NonNullable<ApproveProposalRequest['edits']>): ProposalEditsInput {
  return {
    ...(edits.title !== undefined ? { title: edits.title } : {}),
    ...(edits.body !== undefined ? { body: edits.body } : {}),
    ...(edits.type !== undefined ? { type: edits.type } : {}),
    ...(edits.language ? { language: edits.language } : {}),
    ...(edits.categories !== undefined ? { categories: edits.categories } : {}),
    ...(edits.tags !== undefined ? { tags: edits.tags } : {}),
    ...(edits.valid_from !== undefined ? { validFrom: edits.valid_from } : {}),
    ...(edits.valid_until !== undefined ? { validUntil: edits.valid_until } : {}),
    ...(edits.observed_at !== undefined ? { observedAt: edits.observed_at } : {}),
    ...(edits.sources !== undefined ? { sources: edits.sources } : {}),
    ...(edits.relations !== undefined ? { relations: edits.relations } : {}),
    ...(edits.summary_of !== undefined ? { summaryOf: edits.summary_of } : {}),
  };
}

function summary(proposal: ProposalRecord, itemTitles?: Map<string, string>): ProposalSummary {
  return {
    id: proposal.id,
    workspace_id: proposal.workspaceId,
    proposal_type: proposal.proposalType,
    status: proposal.status,
    title:
      proposedTitle(proposal) ??
      (proposal.targetItemId ? (itemTitles?.get(proposal.targetItemId) ?? null) : null),
    categories: proposedCategories(proposal) as ProposalSummary['categories'],
    target_item_id: proposal.targetItemId,
    acknowledged_duplicate_ids:
      proposal.acknowledgedDuplicateIds as ProposalSummary['acknowledged_duplicate_ids'],
    proposed_by_actor_id: proposal.proposedByActorId,
    base_revision_id: proposal.baseRevisionId,
    base_content_hash: proposal.baseContentHash,
    reason: proposal.reason,
    confidence: proposal.confidence,
    policy_decision: proposal.policyDecision,
    created_at: proposal.createdAt.toISOString(),
    resolved_at: proposal.resolvedAt?.toISOString() ?? null,
    resolved_by_actor_id: proposal.resolvedByActorId,
    resolution_note: proposal.resolutionNote,
    result_revision_ids: proposal.resultRevisionIds,
    sync_session_id: proposal.syncSessionId,
  };
}

/** Everything, or only what this actor proposed. */
async function readScope(
  services: Services,
  actor: Awaited<ReturnType<typeof resolveWorkspaceActor>>,
): Promise<'all' | 'own'> {
  const all = await services.authorization.check(
    actor.context,
    actor.standing,
    'proposal.read_all',
  );
  if (all.allowed) return 'all';
  await services.authorization.require(actor.context, actor.standing, 'proposal.read_own');
  return 'own';
}

/**
 * One proposal, named. A mutation answers about a single proposal, so it
 * looks the one title up rather than batching, which the list does.
 */
async function named(
  services: Services,
  workspaceId: ProposalRecord['workspaceId'],
  proposal: ProposalRecord,
): Promise<ProposalSummary> {
  const titles = await services.repositories.knowledge.titlesOf(
    workspaceId,
    proposal.targetItemId ? [proposal.targetItemId] : [],
  );
  return summary(proposal, titles);
}

export function registerProposalRoutes(app: FastifyInstance, services: Services): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/v1/proposal.list',
    { schema: { querystring: ProposalListInput, response: { 200: ProposalsResponse } } },
    (request) => proposalList(services, request, request.query),
  );

  r.get(
    '/v1/proposal.get',
    { schema: { querystring: ProposalGetInput, response: { 200: ProposalResponse } } },
    (request) => proposalGet(services, request, request.query),
  );
}

/** The read tools, shared by the `GET` routes above and the tool routes. */
export async function proposalList(
  services: Services,
  request: FastifyRequest,
  input: ProposalListInput,
): Promise<ProposalsResponse> {
  const actor = await resolveWorkspaceActor(services, request);
  const scope = await readScope(services, actor);
  const proposals = await services.proposals.list(actor.context.workspaceId, {
    limit: input.limit,
    ...(input.status ? { status: input.status } : {}),
    ...(input.sync_session_id ? { syncSessionId: input.sync_session_id } : {}),
    ...(scope === 'own' ? { proposedByActorId: actor.context.actorId } : {}),
  });
  // One lookup for the whole page: a row naming an item has to say which.
  const titles = await services.repositories.knowledge.titlesOf(
    actor.context.workspaceId,
    proposals.flatMap((p) => (p.targetItemId ? [p.targetItemId] : [])),
  );
  return { proposals: proposals.map((p) => summary(p, titles)) };
}

export async function proposalGet(
  services: Services,
  request: FastifyRequest,
  input: ProposalGetInput,
): Promise<ProposalResponse> {
  const actor = await resolveWorkspaceActor(services, request);
  const scope = await readScope(services, actor);
  const proposal = await services.proposals.get(actor.context.workspaceId, input.proposal_id);
  // Somebody who may only read their own is told the same thing about a
  // proposal that is not theirs as about one that does not exist.
  if (scope === 'own' && proposal.proposedByActorId !== actor.context.actorId) {
    throw new DomainError('NOT_FOUND', 'proposal not found', {
      objectIds: { proposal: input.proposal_id },
    });
  }
  const titles = await services.repositories.knowledge.titlesOf(
    actor.context.workspaceId,
    proposal.targetItemId ? [proposal.targetItemId] : [],
  );
  return {
    proposal: { ...summary(proposal, titles), proposed_payload: proposal.proposedPayload },
  };
}

/**
 * The proposal tools.
 *
 * Each is a tool, so each is reachable at `POST /v1/<tool_name>` and, once the
 * MCP endpoint exists, as a tool of that name. The registrar in `tools.ts`
 * creates the HTTP route from the contract; what a proposal means is here.
 *
 * Every one of them takes an idempotency key. An agent retrying over a
 * dropped connection is the case it exists for: without it the retry leaves a
 * second proposal in the inbox, or a second item when policy allows the write
 * directly.
 */
export async function knowledgeProposeCreate(
  services: Services,
  request: FastifyRequest,
  body: ProposeCreateRequest,
): Promise<ProposalResult> {
  const actor = await resolveWorkspaceActor(services, request);
  const replayable = await services.idempotency.run(
    actor.context,
    idempotencyKey(request),
    'knowledge_propose_create',
    body,
    async () => {
      const outcome = await services.proposals.proposeCreate(actor.context, actor.standing, {
        ...contentInput(body),
        ...proposalExtras(body),
      });
      return {
        proposal: await named(services, actor.context.workspaceId, outcome.proposal),
        item_id: outcome.itemId,
      };
    },
  );
  return replayable.value;
}

export async function knowledgeProposeUpdate(
  services: Services,
  request: FastifyRequest,
  body: ProposeUpdateRequest,
): Promise<ProposalResult> {
  const actor = await resolveWorkspaceActor(services, request);
  const replayable = await services.idempotency.run(
    actor.context,
    idempotencyKey(request),
    'knowledge_propose_update',
    body,
    async () => {
      const outcome = await services.proposals.proposeUpdate(actor.context, actor.standing, {
        ...changeInput(body),
        ...proposalExtras(body),
      });
      return {
        proposal: await named(services, actor.context.workspaceId, outcome.proposal),
        item_id: outcome.itemId,
      };
    },
  );
  return replayable.value;
}

export async function knowledgeProposeDelete(
  services: Services,
  request: FastifyRequest,
  body: ProposeDeleteRequest,
): Promise<ProposalResult> {
  const actor = await resolveWorkspaceActor(services, request);
  const replayable = await services.idempotency.run(
    actor.context,
    idempotencyKey(request),
    'knowledge_propose_delete',
    body,
    async () => {
      const outcome = await services.proposals.proposeDelete(actor.context, actor.standing, {
        itemId: body.item_id,
        baseRevisionId: body.base_revision_id,
        baseContentHash: body.base_content_hash,
        reason: body.reason,
        confidence: body.confidence,
      });
      return {
        proposal: await named(services, actor.context.workspaceId, outcome.proposal),
        item_id: outcome.itemId,
      };
    },
  );
  return replayable.value;
}

export async function knowledgeProposeSupersede(
  services: Services,
  request: FastifyRequest,
  body: ProposeSupersedeRequest,
): Promise<ProposalResult> {
  const actor = await resolveWorkspaceActor(services, request);
  const replayable = await services.idempotency.run(
    actor.context,
    idempotencyKey(request),
    'knowledge_propose_supersede',
    body,
    async () => {
      const outcome = await services.proposals.proposeSupersede(actor.context, actor.standing, {
        oldItemId: body.old_item_id,
        oldBaseRevisionId: body.old_base_revision_id,
        oldBaseContentHash: body.old_base_content_hash,
        validUntil: body.valid_until,
        ...(body.new_item ? { newItem: contentInput(body.new_item) } : {}),
        ...(body.existing_item
          ? {
              existingItem: {
                itemId: body.existing_item.item_id,
                baseRevisionId: body.existing_item.base_revision_id,
                baseContentHash: body.existing_item.base_content_hash,
              },
            }
          : {}),
        reason: body.reason,
        confidence: body.confidence,
      });
      return {
        proposal: await named(services, actor.context.workspaceId, outcome.proposal),
        item_id: outcome.itemId,
      };
    },
  );
  return replayable.value;
}

/**
 * The review decisions. An agent holding `knowledge.approve` calls these as
 * readily as a person does, which is why they are tools at all.
 */
export async function proposalApprove(
  services: Services,
  request: FastifyRequest,
  body: ApproveProposalRequest,
): Promise<ProposalResult> {
  const actor = await resolveWorkspaceActor(services, request);
  // A retried approval must not produce a second item from one proposal. The
  // proposal's own status catches the ordinary case; this catches the retry
  // that arrives before the first call has finished writing.
  const replayable = await services.idempotency.run(
    actor.context,
    idempotencyKey(request),
    'proposal_approve',
    body,
    async () => {
      const outcome = await services.proposals.approve(actor.context, actor.standing, {
        proposalId: body.proposal_id,
        ...(body.edits ? { edits: editsFor(body.edits) } : {}),
        note: body.note,
      });
      return {
        proposal: await named(services, actor.context.workspaceId, outcome.proposal),
        item_id: outcome.itemId,
      };
    },
  );
  return replayable.value;
}

export async function proposalReject(
  services: Services,
  request: FastifyRequest,
  body: RejectProposalRequest,
): Promise<ProposalResult> {
  const actor = await resolveWorkspaceActor(services, request);
  const proposal = await services.proposals.reject(actor.context, actor.standing, {
    proposalId: body.proposal_id,
    reason: body.reason,
  });
  // Nothing was written, so no item: a rejection is a decision, not a change.
  return { proposal: await named(services, actor.context.workspaceId, proposal), item_id: null };
}

export async function proposalWithdraw(
  services: Services,
  request: FastifyRequest,
  body: WithdrawProposalRequest,
): Promise<ProposalResult> {
  const actor = await resolveWorkspaceActor(services, request);
  const proposal = await services.proposals.withdraw(actor.context, actor.standing, {
    proposalId: body.proposal_id,
    reason: body.reason,
  });
  return { proposal: await named(services, actor.context.workspaceId, proposal), item_id: null };
}
