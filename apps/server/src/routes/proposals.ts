import {
  ApproveProposalRequest,
  ProposalId,
  ProposalResponse,
  ProposalResult,
  ProposalsResponse,
  ProposeCreateRequest,
  ProposeDeleteRequest,
  ProposeSupersedeRequest,
  ProposeUpdateRequest,
  ProposalStatus,
  RejectProposalRequest,
  WithdrawProposalRequest,
  type ProposalSummary,
} from '@knoverge/contracts';
import { DomainError, type ProposalRecord } from '@knoverge/core';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { idempotencyKey, resolveWorkspaceActor } from '../plugins/actor-context.ts';
import { csrfUnlessBearer } from '../plugins/security.ts';
import type { Services } from '../services.ts';

function summary(proposal: ProposalRecord): ProposalSummary {
  return {
    id: proposal.id,
    workspace_id: proposal.workspaceId,
    proposal_type: proposal.proposalType,
    status: proposal.status,
    target_item_id: proposal.targetItemId,
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

export function registerProposalRoutes(app: FastifyInstance, services: Services): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    '/v1/knowledge_propose_create',
    {
      onRequest: csrfUnlessBearer(app),
      schema: {
        body: ProposeCreateRequest,
        // 202 when somebody still has to look at it, 200 when policy let it
        // through and the item exists already.
        response: { 200: ProposalResult, 202: ProposalResult },
      },
    },
    async (request, reply) => {
      // The tool name, because this is a tool: an agent's way to contribute.
      // The permission and the policy are both decided inside the service.
      const actor = await resolveWorkspaceActor(services, request);
      const body = request.body;
      // An agent retrying over a dropped connection is the case the key exists
      // for: without it the retry leaves a second proposal in the inbox, or a
      // second item when policy allows the write directly.
      const replayable = await services.idempotency.run(
        actor.context,
        idempotencyKey(request),
        'knowledge_propose_create',
        body,
        async () => {
          const outcome = await services.proposals.proposeCreate(actor.context, actor.standing, {
            title: body.title,
            body: body.body,
            type: body.type,
            language: body.language,
            categories: body.categories,
            tags: body.tags,
            slug: body.slug,
            sources: body.sources,
            relations: body.relations,
            external: body.external,
            reason: body.reason,
            confidence: body.confidence,
            acknowledgedDuplicateIds: body.acknowledged_duplicate_ids,
          });
          return { proposal: summary(outcome.proposal), item_id: outcome.itemId };
        },
      );
      // 202 when somebody still has to look at it, so a caller can tell the
      // difference between "recorded" and "done" without reading the status.
      // A replay answers the same way the first call did.
      if (replayable.value.item_id === null) reply.code(202);
      return replayable.value;
    },
  );

  r.post(
    '/v1/knowledge_propose_update',
    {
      onRequest: csrfUnlessBearer(app),
      schema: {
        body: ProposeUpdateRequest,
        response: { 200: ProposalResult, 202: ProposalResult },
      },
    },
    async (request, reply) => {
      const actor = await resolveWorkspaceActor(services, request);
      const body = request.body;
      const replayable = await services.idempotency.run(
        actor.context,
        idempotencyKey(request),
        'knowledge_propose_update',
        body,
        async () => {
          const outcome = await services.proposals.proposeUpdate(actor.context, actor.standing, {
            itemId: body.item_id,
            baseRevisionId: body.base_revision_id,
            baseContentHash: body.base_content_hash,
            title: body.title,
            body: body.body,
            type: body.type,
            language: body.language,
            categories: body.categories,
            tags: body.tags,
            validFrom: body.valid_from,
            validUntil: body.valid_until,
            observedAt: body.observed_at,
            sources: body.sources,
            relations: body.relations,
            reason: body.reason,
            confidence: body.confidence,
          });
          return { proposal: summary(outcome.proposal), item_id: outcome.itemId };
        },
      );
      if (replayable.value.item_id === null) reply.code(202);
      return replayable.value;
    },
  );

  r.post(
    '/v1/knowledge_propose_delete',
    {
      onRequest: csrfUnlessBearer(app),
      schema: {
        body: ProposeDeleteRequest,
        response: { 200: ProposalResult, 202: ProposalResult },
      },
    },
    async (request, reply) => {
      const actor = await resolveWorkspaceActor(services, request);
      const body = request.body;
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
          return { proposal: summary(outcome.proposal), item_id: outcome.itemId };
        },
      );
      if (replayable.value.item_id === null) reply.code(202);
      return replayable.value;
    },
  );

  r.post(
    '/v1/knowledge_propose_supersede',
    {
      onRequest: csrfUnlessBearer(app),
      schema: {
        body: ProposeSupersedeRequest,
        response: { 200: ProposalResult, 202: ProposalResult },
      },
    },
    async (request, reply) => {
      const actor = await resolveWorkspaceActor(services, request);
      const body = request.body;
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
            ...(body.new_item
              ? {
                  newItem: {
                    title: body.new_item.title,
                    body: body.new_item.body,
                    type: body.new_item.type,
                    language: body.new_item.language,
                    categories: body.new_item.categories,
                    tags: body.new_item.tags,
                    slug: body.new_item.slug,
                    observedAt: body.new_item.observed_at,
                    relations: body.new_item.relations,
                    sources: body.new_item.sources,
                    external: body.new_item.external,
                  },
                }
              : {}),
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
          return { proposal: summary(outcome.proposal), item_id: outcome.itemId };
        },
      );
      if (replayable.value.item_id === null) reply.code(202);
      return replayable.value;
    },
  );

  /**
   * The review decisions. These are tools an agent with `knowledge.approve`
   * may call as readily as a person, so they carry the tool names.
   */
  r.post(
    '/v1/proposal_approve',
    {
      onRequest: csrfUnlessBearer(app),
      schema: { body: ApproveProposalRequest, response: { 200: ProposalResult } },
    },
    async (request) => {
      const actor = await resolveWorkspaceActor(services, request);
      const body = request.body;
      // A retried approval must not produce a second item from one proposal.
      // The proposal's own status catches the ordinary case; this catches the
      // retry that arrives before the first call has finished writing.
      const replayable = await services.idempotency.run(
        actor.context,
        idempotencyKey(request),
        'proposal_approve',
        body,
        async () => {
          const outcome = await services.proposals.approve(actor.context, actor.standing, {
            proposalId: body.proposal_id,
            edits: body.edits,
            note: body.note,
          });
          return { proposal: summary(outcome.proposal), item_id: outcome.itemId };
        },
      );
      return replayable.value;
    },
  );

  r.post(
    '/v1/proposal_reject',
    {
      onRequest: csrfUnlessBearer(app),
      schema: { body: RejectProposalRequest, response: { 200: ProposalResult } },
    },
    async (request) => {
      const actor = await resolveWorkspaceActor(services, request);
      const proposal = await services.proposals.reject(actor.context, actor.standing, {
        proposalId: request.body.proposal_id,
        reason: request.body.reason,
      });
      // Nothing was written, so no item: a rejection is a decision, not a change.
      return { proposal: summary(proposal), item_id: null };
    },
  );

  r.post(
    '/v1/proposal_withdraw',
    {
      onRequest: csrfUnlessBearer(app),
      schema: { body: WithdrawProposalRequest, response: { 200: ProposalResult } },
    },
    async (request) => {
      const actor = await resolveWorkspaceActor(services, request);
      const proposal = await services.proposals.withdraw(actor.context, actor.standing, {
        proposalId: request.body.proposal_id,
        reason: request.body.reason,
      });
      return { proposal: summary(proposal), item_id: null };
    },
  );

  /**
   * One pair of routes for the reviewer and the proposer, narrowed by what the
   * caller holds. Two sets would mean two places to keep the scoping right,
   * and the one an agent uses is the one that would drift.
   */
  r.get(
    '/v1/proposal.list',
    {
      schema: {
        querystring: z.object({ status: ProposalStatus.optional() }),
        response: { 200: ProposalsResponse },
      },
    },
    async (request) => {
      const actor = await resolveWorkspaceActor(services, request);
      const scope = await readScope(services, actor);
      const proposals = await services.proposals.list(actor.context.workspaceId, {
        ...(request.query.status ? { status: request.query.status } : {}),
        ...(scope === 'own' ? { proposedByActorId: actor.context.actorId } : {}),
      });
      return { proposals: proposals.map(summary) };
    },
  );

  r.get(
    '/v1/proposal.get',
    {
      schema: {
        querystring: z.object({ proposal_id: ProposalId }),
        response: { 200: ProposalResponse },
      },
    },
    async (request) => {
      const actor = await resolveWorkspaceActor(services, request);
      const scope = await readScope(services, actor);
      const proposal = await services.proposals.get(
        actor.context.workspaceId,
        request.query.proposal_id,
      );
      // Somebody who may only read their own is told the same thing about a
      // proposal that is not theirs as about one that does not exist.
      if (scope === 'own' && proposal.proposedByActorId !== actor.context.actorId) {
        throw new DomainError('NOT_FOUND', 'proposal not found', {
          objectIds: { proposal: request.query.proposal_id },
        });
      }
      return {
        proposal: { ...summary(proposal), proposed_payload: proposal.proposedPayload },
      };
    },
  );
}
