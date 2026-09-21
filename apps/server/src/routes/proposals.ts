import {
  ProposalResponse,
  ProposalResult,
  ProposalsResponse,
  ProposeCreateRequest,
  ProposalStatus,
  type ProposalSummary,
} from '@knoverge/contracts';
import type { ProposalRecord } from '@knoverge/core';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { requirePermission, resolveWorkspaceActor } from '../plugins/actor-context.ts';
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
      const outcome = await services.proposals.proposeCreate(actor.context, actor.standing, {
        title: request.body.title,
        body: request.body.body,
        type: request.body.type,
        language: request.body.language,
        categories: request.body.categories,
        tags: request.body.tags,
        slug: request.body.slug,
        sources: request.body.sources,
        relations: request.body.relations,
        external: request.body.external,
        reason: request.body.reason,
        confidence: request.body.confidence,
      });
      // 202 when somebody still has to look at it, so a caller can tell the
      // difference between "recorded" and "done" without reading the status.
      if (outcome.itemId === null) reply.code(202);
      return { proposal: summary(outcome.proposal), item_id: outcome.itemId };
    },
  );

  r.get(
    '/v1/admin/proposals.list',
    {
      schema: {
        querystring: z.object({ status: ProposalStatus.optional() }),
        response: { 200: ProposalsResponse },
      },
    },
    async (request) => {
      const actor = await requirePermission(services, request, 'knowledge.approve');
      const proposals = await services.proposals.list(actor.context.workspaceId, {
        ...(request.query.status ? { status: request.query.status } : {}),
      });
      return { proposals: proposals.map(summary) };
    },
  );

  r.get(
    '/v1/admin/proposals.get',
    {
      schema: {
        querystring: z.object({ proposal_id: z.string().min(1).max(64) }),
        response: { 200: ProposalResponse },
      },
    },
    async (request) => {
      const actor = await requirePermission(services, request, 'knowledge.approve');
      const proposal = await services.proposals.get(
        actor.context.workspaceId,
        request.query.proposal_id as never,
      );
      return {
        proposal: { ...summary(proposal), proposed_payload: proposal.proposedPayload },
      };
    },
  );
}
