import {
  CreateKnowledgeRequest,
  DeleteKnowledgeRequest,
  KnowledgeDiffInput,
  KnowledgeDiffResponse,
  KnowledgeItemId,
  KnowledgeHistoryInput,
  KnowledgeListQuery,
  KnowledgeListResponse,
  KnowledgeResponse,
  RestoreKnowledgeRequest,
  SupersedeKnowledgeRequest,
  SupersedeResponse,
  RevisionsResponse,
  UpdateKnowledgeRequest,
  type KnowledgeItemDetail,
  type KnowledgeItemSummary,
  type RevisionSummary,
} from '@knoverge/contracts';
import type {
  CategoryId,
  KnowledgeGetInput,
  KnowledgeSearchInput,
  KnowledgeSearchResponse,
} from '@knoverge/contracts';
import {
  DomainError,
  MAX_BODY_BYTES,
  type ItemResult,
  type ItemSummary,
  type RevisionRecord,
} from '@knoverge/core';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import { requireListPermission, requirePermission } from '../plugins/actor-context.ts';
import { csrfUnlessBearer } from '../plugins/security.ts';
import type { Services } from '../services.ts';

function revisionSummary(revision: RevisionRecord): RevisionSummary {
  return {
    id: revision.id,
    revision_number: revision.revisionNumber,
    change_kind: revision.changeKind,
    title: revision.title,
    markdown_path: revision.markdownPath,
    content_hash: revision.contentHash,
    frontmatter_hash: revision.frontmatterHash,
    git_commit: revision.gitCommitHash,
    actor_id: revision.createdByActorId,
    created_at: revision.createdAt.toISOString(),
  };
}

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

/** An item answered in full, for the routes a person writes through. */
function whole(result: ItemResult): KnowledgeResponse {
  const item = detail(result);
  return { item, total_chars: result.body.length, truncated: false };
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
    sources: revision.frontmatter.sources,
    relations: revision.frontmatter.relations,
    content_hash: revision.contentHash,
    frontmatter_hash: revision.frontmatterHash,
    revision_number: revision.revisionNumber,
  } as KnowledgeItemDetail;
}

/**
 * Rule 14: an agent write needs a policy rule that allows it directly, and the
 * machinery that decides is the proposal workflow of Milestone 3. Until it
 * exists, holding `knowledge.write` is not enough — a trusted agent holds it,
 * and letting one through here would be the unreviewed write the rule exists
 * to prevent.
 *
 * Not POLICY_REQUIRES_REVIEW: that answers 202, which would say the write was
 * accepted for review when nothing was accepted at all. It becomes the right
 * answer once a proposal is actually created.
 */
function assertHuman(actorType: string): void {
  if (actorType !== 'human') {
    throw new DomainError(
      'FORBIDDEN',
      'an agent proposes rather than writes directly; the review workflow that accepts a proposal arrives in a later milestone',
    );
  }
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
      assertHuman(actor.context.actorType);
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
        relations: request.body.relations,
        sources: request.body.sources,
        external: request.body.external,
      });
      return whole(result);
    },
  );

  r.post(
    '/v1/admin/knowledge.update',
    {
      onRequest: csrfUnlessBearer(app),
      schema: { body: UpdateKnowledgeRequest, response: { 200: KnowledgeResponse } },
    },
    async (request) => {
      const actor = await requirePermission(services, request, 'knowledge.write');
      assertHuman(actor.context.actorType);
      const result = await services.knowledge.update(actor.context, {
        itemId: request.body.item_id,
        baseRevisionId: request.body.base_revision_id,
        baseContentHash: request.body.base_content_hash,
        title: request.body.title,
        body: request.body.body,
        type: request.body.type,
        language: request.body.language,
        categories: request.body.categories,
        tags: request.body.tags,
        validFrom: request.body.valid_from,
        validUntil: request.body.valid_until,
        observedAt: request.body.observed_at,
        sources: request.body.sources,
        relations: request.body.relations,
      });
      return whole(result);
    },
  );

  r.post(
    '/v1/admin/knowledge.delete',
    {
      onRequest: csrfUnlessBearer(app),
      schema: { body: DeleteKnowledgeRequest, response: { 200: KnowledgeResponse } },
    },
    async (request) => {
      const actor = await requirePermission(services, request, 'knowledge.write');
      assertHuman(actor.context.actorType);
      const result = await services.knowledge.delete(actor.context, {
        itemId: request.body.item_id,
        baseRevisionId: request.body.base_revision_id,
        baseContentHash: request.body.base_content_hash,
      });
      return whole(result);
    },
  );

  r.post(
    '/v1/admin/knowledge.restore',
    {
      onRequest: csrfUnlessBearer(app),
      schema: { body: RestoreKnowledgeRequest, response: { 200: KnowledgeResponse } },
    },
    async (request) => {
      const actor = await requirePermission(services, request, 'knowledge.write');
      assertHuman(actor.context.actorType);
      const result = await services.knowledge.restore(actor.context, request.body.item_id);
      return whole(result);
    },
  );

  r.post(
    '/v1/admin/knowledge.supersede',
    {
      onRequest: csrfUnlessBearer(app),
      schema: { body: SupersedeKnowledgeRequest, response: { 200: SupersedeResponse } },
    },
    async (request) => {
      const actor = await requirePermission(services, request, 'knowledge.write');
      assertHuman(actor.context.actorType);
      const body = request.body;
      const result = await services.knowledge.supersede(actor.context, {
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
      });
      return { item: detail(result.new), superseded: detail(result.old) };
    },
  );

  r.get(
    '/v1/knowledge.revisions',
    { schema: { querystring: KnowledgeHistoryInput, response: { 200: RevisionsResponse } } },
    (request) => knowledgeHistory(services, request, request.query),
  );

  r.get(
    '/v1/knowledge.diff',
    { schema: { querystring: KnowledgeDiffInput, response: { 200: KnowledgeDiffResponse } } },
    (request) => knowledgeDiff(services, request, request.query),
  );

  r.get(
    '/v1/knowledge.list',
    { schema: { querystring: KnowledgeListQuery, response: { 200: KnowledgeListResponse } } },
    async (request) => {
      const actor = await requirePermission(services, request, 'knowledge.read');
      const query = request.query;
      const workspaceId = actor.context.workspaceId;
      // A path at the boundary, ids underneath (rule 13), and the whole branch:
      // browsing `architecture` means the architecture, not the few items filed
      // at its root.
      let categoryIds: CategoryId[] | undefined;
      if (query.category_path !== undefined) {
        const category = await services.repositories.categories.findByPath(
          workspaceId,
          query.category_path,
        );
        if (!category) {
          throw new DomainError('NOT_FOUND', `no category at ${query.category_path}`, {
            objectIds: { path: query.category_path },
          });
        }
        const subtree = await services.repositories.categories.listSubtree(
          workspaceId,
          category.path,
        );
        categoryIds = subtree.map((c) => c.id);
      }
      // One more than asked for, so the cursor is null exactly when there is
      // nothing after this page. Answering null while more exists is how a
      // list tells somebody their workspace is smaller than it is.
      const items = await services.knowledge.list(actor.context, {
        limit: query.limit + 1,
        ...(query.cursor ? { after: query.cursor } : {}),
        ...(categoryIds ? { categoryIds } : {}),
        ...(query.types.length > 0 ? { types: query.types } : {}),
        ...(query.review_states.length > 0 ? { reviewStates: query.review_states } : {}),
        ...(query.status ? { status: query.status } : {}),
      });
      const page = items.slice(0, query.limit);
      return {
        items: page.map(summary),
        next_cursor:
          items.length > query.limit ? ((page[page.length - 1]?.item.id ?? null) as never) : null,
      };
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
    // The whole body, always. The editor writes back what it was given, and a
    // budget here would mean a person opening a long document and saving the
    // first twenty thousand characters of it over the rest.
    (request) =>
      knowledgeGet(services, request, {
        item_id: request.query['item_id'],
        revision_id: null,
        include_provenance: true,
        include_relations: true,
        max_chars: MAX_BODY_BYTES,
        offset: 0,
      }),
  );
}

/**
 * The tool handlers, which the `GET` routes above and the generated
 * `POST /v1/<tool_name>` routes both call. One handler, two transports: that
 * is what ADR 0011 settles for a read that is also a tool.
 */
export async function knowledgeGet(
  services: Services,
  request: FastifyRequest,
  input: KnowledgeGetInput,
): Promise<KnowledgeResponse> {
  const actor = await requirePermission(services, request, 'knowledge.read');
  const result = await services.knowledge.get(
    actor.context,
    input.item_id,
    input.revision_id ?? undefined,
  );
  // Bounded, because a document may run to two hundred kilobytes and an agent
  // that asks for one should not lose its context to it. The answer says how
  // much there was, so a caller asks for the rest rather than working from a
  // fragment without knowing it is one.
  const whole = result.body;
  const slice = whole.slice(input.offset, input.offset + input.max_chars);
  const item = detail({ ...result, body: slice });
  return {
    item: {
      ...item,
      ...(input.include_provenance ? {} : { sources: [] }),
      ...(input.include_relations ? {} : { relations: [] }),
    },
    total_chars: whole.length,
    truncated: input.offset > 0 || slice.length < whole.length,
  };
}

/**
 * Finding knowledge by what it says.
 *
 * Rule 8: this returns candidates. Each carries the revision and content hash
 * it was found at, so a caller that wants to act on one reads the canonical
 * item first and sees whether it has moved on.
 *
 * A scoped grant searches its own branch. The filter runs over the results,
 * which is right for a read: a hit the caller may not see is not a hit, and
 * the alternative — refusing the whole search — would deny anybody whose
 * grant covers one category.
 */
export async function knowledgeSearch(
  services: Services,
  request: FastifyRequest,
  input: KnowledgeSearchInput,
): Promise<KnowledgeSearchResponse> {
  const actor = await requireListPermission(services, request, 'knowledge.search');
  const workspaceId = actor.context.workspaceId;

  // Paths to ids before anything is authorised, and the subtree with them: a
  // search in `projects` means the projects, not only the folder itself.
  const categoryIds: string[] = [];
  for (const path of input.category_paths) {
    const category = await services.repositories.categories.findByPath(workspaceId, path);
    if (!category) {
      throw new DomainError('NOT_FOUND', `no category at ${path}`, { objectIds: { path } });
    }
    const subtree = await services.repositories.categories.listSubtree(workspaceId, category.path);
    categoryIds.push(...subtree.map((c) => c.id));
  }

  // The workspace's own language parses the query when the caller names none:
  // a query parsed as `simple` never meets a stemmed vector.
  const workspace = await services.repositories.workspaces.findById(workspaceId);
  const hits = await services.repositories.search.search({
    workspaceId,
    text: input.query,
    ...(workspace ? { defaultLanguage: workspace.defaultLanguage } : {}),
    ...(categoryIds.length ? { categoryIds } : {}),
    ...(input.types.length ? { types: input.types } : {}),
    ...(input.statuses.length ? { statuses: input.statuses } : {}),
    ...(input.languages.length ? { languages: input.languages } : {}),
    ...(input.review_states.length ? { reviewStates: input.review_states } : {}),
    includeDisputed: input.include_disputed,
    limit: input.limit,
    includeSnippets: input.include_snippets,
  });
  if (hits.length === 0) return { results: [] };

  // The categories each hit belongs to, for the cards and for the filter.
  const rows = await services.repositories.knowledge.categoriesOf(
    workspaceId,
    hits.map((hit) => hit.itemId),
  );
  const tree = await services.repositories.categories.list(workspaceId, { includeArchived: true });
  const pathOf = new Map(tree.map((c) => [c.id, c.path]));
  const byItem = new Map<string, { ids: string[]; paths: string[] }>();
  for (const row of rows) {
    const entry = byItem.get(row.knowledgeItemId) ?? { ids: [], paths: [] };
    entry.ids.push(row.categoryId);
    const path = pathOf.get(row.categoryId);
    if (path) entry.paths.push(path);
    byItem.set(row.knowledgeItemId, entry);
  }

  const visible = await services.authorization.filter(
    actor.context,
    actor.standing,
    'knowledge.read',
    hits,
    (hit) => ({ categoryIds: byItem.get(hit.itemId)?.ids ?? [] }),
  );

  return {
    results: visible.map((hit) => ({
      item_id: hit.itemId,
      title: hit.title,
      type: hit.type,
      status: hit.status,
      language: hit.language,
      review_state: hit.reviewState,
      evidence_state: hit.evidenceState,
      disputed: hit.disputed,
      category_paths: byItem.get(hit.itemId)?.paths ?? [],
      revision_id: hit.revisionId,
      content_hash: hit.contentHash,
      updated_at: hit.updatedAt.toISOString(),
      score: hit.score,
      chunk_ordinal: hit.chunkOrdinal,
      score_components: { title: hit.components.title, lexical: hit.components.lexical },
      snippet: hit.snippet,
    })) as KnowledgeSearchResponse['results'],
  };
}

export async function knowledgeHistory(
  services: Services,
  request: FastifyRequest,
  input: KnowledgeHistoryInput,
): Promise<RevisionsResponse> {
  const actor = await requirePermission(services, request, 'knowledge.read_history');
  const revisions = await services.knowledge.history(actor.context, input.item_id);
  return { revisions: revisions.map(revisionSummary) };
}

export async function knowledgeDiff(
  services: Services,
  request: FastifyRequest,
  input: KnowledgeDiffInput,
): Promise<KnowledgeDiffResponse> {
  // Past content, so the history permission rather than the read one.
  const actor = await requirePermission(services, request, 'knowledge.read_history');
  const result = await services.knowledge.diff(
    actor.context,
    input.item_id,
    input.from_revision_id,
    input.to_revision_id,
  );
  return {
    from: revisionSummary(result.from),
    to: revisionSummary(result.to),
    body_diff: result.bodyDiff,
    metadata_changes: result.metadata,
  };
}
