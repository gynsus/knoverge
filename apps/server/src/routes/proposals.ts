import {
  ProposalId,
  ProposalResponse,
  ProposalResult,
  ProposalsResponse,
  ProposeCreateRequest,
  ProposalStatus,
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
