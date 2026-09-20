import { z } from 'zod';

import {
  CreateKnowledgeRequest,
  KnowledgeItemId,
  KnowledgeListResponse,
  KnowledgeResponse,
  type KnowledgeItemDetail,
  type KnowledgeItemSummary,
} from '@knoverge/contracts';
import { DomainError, type ItemResult, type ItemSummary } from '@knoverge/core';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import { requirePermission } from '../plugins/actor-context.ts';
import { csrfUnlessBearer } from '../plugins/security.ts';
import type { Services } from '../services.ts';

function summary(entry: ItemSummary): KnowledgeItemSummary {
  const { item } = entry;
  return {
    id: item.id,
    workspace_id: item.workspaceId,
    slug: item.slug,
    markdown_path: item.markdownPath,
    title: entry.title,
    type: item.type,
    status: item.status,
    language: item.language,
    current_revision_id: item.currentRevisionId,
    review_state: item.reviewState,
    evidence_state: item.evidenceState,
    disputed: item.disputed,
    categories: entry.categories,
    tags: entry.tags,
    valid_from: item.validFrom?.toISOString() ?? null,
    valid_until: item.validUntil?.toISOString() ?? null,
    observed_at: item.observedAt?.toISOString() ?? null,
    created_at: item.createdAt.toISOString(),
    updated_at: item.updatedAt.toISOString(),
  } as KnowledgeItemSummary;
}

function detail(result: ItemResult): KnowledgeItemDetail {
  const { item, revision } = result;
  return {
    id: item.id,
    workspace_id: item.workspaceId,
    slug: item.slug,
    markdown_path: item.markdownPath,
    title: revision.title,
    type: item.type,
    status: item.status,
    language: item.language,
    current_revision_id: revision.id,
    review_state: item.reviewState,
    evidence_state: item.evidenceState,
    disputed: item.disputed,
    categories: result.categories,
    tags: result.tags,
    valid_from: item.validFrom?.toISOString() ?? null,
    valid_until: item.validUntil?.toISOString() ?? null,
    observed_at: item.observedAt?.toISOString() ?? null,
    created_at: item.createdAt.toISOString(),
    updated_at: item.updatedAt.toISOString(),
    body: result.body,
    content_hash: revision.contentHash,
    frontmatter_hash: revision.frontmatterHash,
    revision_number: revision.revisionNumber,
  } as KnowledgeItemDetail;
}

export function registerKnowledgeRoutes(app: FastifyInstance, services: Services): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    '/v1/admin/knowledge.create',
    {
      onRequest: csrfUnlessBearer(app),
      schema: { body: CreateKnowledgeRequest, response: { 200: KnowledgeResponse } },
    },
    async (request) => {
      const actor = await requirePermission(services, request, 'knowledge.write');
      // Rule 14: an agent write needs a policy rule that allows it directly,
      // and the machinery that decides is the proposal workflow of Milestone 3.
      // Until it exists, holding the permission is not enough — letting a
      // trusted agent through here would be the unreviewed write the rule
      // exists to prevent.
      if (actor.context.actorType !== 'human') {
        // Not POLICY_REQUIRES_REVIEW: that answers 202, which would say the
        // write was accepted for review when nothing was accepted at all. It
        // becomes the right answer once a proposal is actually created.
        throw new DomainError(
          'FORBIDDEN',
          'an agent proposes rather than writes directly; the review workflow that accepts a proposal arrives in a later milestone',
        );
      }
      const result = await services.knowledge.create(actor.context, {
        title: request.body.title,
        body: request.body.body,
        type: request.body.type,
        language: request.body.language,
        categories: request.body.categories,
        tags: request.body.tags,
        slug: request.body.slug,
        validFrom: request.body.valid_from,
        validUntil: request.body.valid_until,
        observedAt: request.body.observed_at,
        external: request.body.external,
      });
      return { item: detail(result) };
    },
  );

  r.get(
    '/v1/knowledge.list',
    { schema: { response: { 200: KnowledgeListResponse } } },
    async (request) => {
      const actor = await requirePermission(services, request, 'knowledge.read');
      const items = await services.knowledge.list(actor.context, {});
      return { items: items.map(summary), next_cursor: null };
    },
  );

  r.get(
    '/v1/knowledge.get',
    {
      schema: {
        querystring: z.object({ item_id: KnowledgeItemId }),
        response: { 200: KnowledgeResponse },
      },
    },
    async (request) => {
      const actor = await requirePermission(services, request, 'knowledge.read');
      const result = await services.knowledge.get(actor.context, request.query.item_id);
      return { item: detail(result) };
    },
  );
}
