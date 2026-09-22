import {
  ArchiveCategoryRequest,
  CategoryResponse,
  CreateCategoryRequest,
  MergeCategoryRequest,
  MoveCategoryRequest,
  RestoreCategoryRequest,
  TaxonomyListQuery,
  TaxonomyListResponse,
  UpdateCategoryRequest,
  type CategoryId,
  type CategorySummary,
  type WorkspaceId,
} from '@knoverge/contracts';
import type {
  TaxonomyListInput,
  TaxonomyProposeInput,
  TaxonomyProposeResult,
} from '@knoverge/contracts';
import { DomainError, type CategoryRecord, type CategoryWithAliases } from '@knoverge/core';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import {
  idempotencyKey,
  requireListPermission,
  resolveWorkspaceActor,
} from '../plugins/actor-context.ts';
import { csrfUnlessBearer } from '../plugins/security.ts';
import type { Services } from '../services.ts';

function summary(category: CategoryWithAliases, includeGuidance = true): CategorySummary {
  return {
    id: category.id,
    workspace_id: category.workspaceId,
    parent_id: category.parentId,
    slug: category.slug,
    path: category.path,
    name: category.name,
    description: category.description,
    inclusion_guidance: includeGuidance ? category.inclusionGuidance : [],
    exclusion_guidance: includeGuidance ? category.exclusionGuidance : [],
    aliases: category.aliases,
    status: category.status,
    created_at: category.createdAt.toISOString(),
    updated_at: category.updatedAt.toISOString(),
    item_count: category.itemCount,
    subtree_item_count: category.subtreeItemCount,
    created_by_actor_id: category.createdByActorId,
    approved_by_actor_id: category.approvedByActorId,
    merged_into_category_id: category.mergedIntoCategoryId,
  };
}

/**
 * Reads require taxonomy.read, mutations taxonomy.manage. Both come from the
 * caller's role or trust tier by default and can be granted explicitly.
 */
/**
 * The category and everything under it. A mutation that rewrites a subtree is
 * authorised against every category it rewrites, because a scope matches only
 * when it covers all of them.
 */
async function subtreeOf(
  services: Services,
  workspaceId: WorkspaceId,
  categoryId: CategoryId,
): Promise<CategoryId[]> {
  const category = await services.repositories.categories.findById(workspaceId, categoryId);
  if (!category) return [categoryId];
  const subtree = await services.repositories.categories.listSubtree(workspaceId, category.path);
  return subtree.map((c) => c.id);
}

export function registerTaxonomyRoutes(app: FastifyInstance, services: Services): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/v1/taxonomy.list',
    { schema: { querystring: TaxonomyListQuery, response: { 200: TaxonomyListResponse } } },
    (request) => taxonomyList(services, request, request.query),
  );

  r.post(
    '/v1/admin/taxonomy.create',
    {
      onRequest: csrfUnlessBearer(app),
      schema: { body: CreateCategoryRequest, response: { 200: CategoryResponse } },
    },
    async (request) => {
      const body = request.body;
      // A new category lands inside its parent's branch, so that is what the
      // permission is checked against. A root category belongs to no branch,
      // which no category-scoped grant covers.
      const actor = await resolveWorkspaceActor(services, request);
      const parent = body.parent_path
        ? await services.repositories.categories.findByPath(
            actor.context.workspaceId,
            body.parent_path,
          )
        : null;
      await services.authorization.require(actor.context, actor.standing, 'taxonomy.manage', {
        ...(parent ? { categoryIds: [parent.id] } : {}),
      });
      const replayable = await services.idempotency.run(
        actor.context,
        idempotencyKey(request),
        'taxonomy.create',
        body,
        async () => {
          const result = await services.taxonomy.create(actor.context, {
            name: body.name,
            parentPath: body.parent_path,
            slug: body.slug,
            description: body.description,
            inclusionGuidance: body.inclusion_guidance,
            exclusionGuidance: body.exclusion_guidance,
            aliases: body.aliases,
          });
          return { taxonomy_version: result.taxonomyVersion, category: summary(result.category) };
        },
      );
      return replayable.value;
    },
  );

  r.post(
    '/v1/admin/taxonomy.update',
    {
      onRequest: csrfUnlessBearer(app),
      schema: { body: UpdateCategoryRequest, response: { 200: CategoryResponse } },
    },
    async (request) => {
      const body = request.body;
      // A slug change rewrites the path of every descendant, so the permission
      // is checked against all of them. Checking only the category named lets a
      // deny on a child be bypassed by renaming its parent.
      const actor = await resolveWorkspaceActor(services, request);
      await services.authorization.require(actor.context, actor.standing, 'taxonomy.manage', {
        categoryIds:
          body.slug === undefined
            ? [body.category_id]
            : await subtreeOf(services, actor.context.workspaceId, body.category_id),
      });
      const result = await services.taxonomy.update(actor.context, {
        categoryId: body.category_id,
        name: body.name,
        slug: body.slug,
        description: body.description,
        inclusionGuidance: body.inclusion_guidance,
        exclusionGuidance: body.exclusion_guidance,
        aliases: body.aliases,
      });
      return { taxonomy_version: result.taxonomyVersion, category: summary(result.category) };
    },
  );

  r.post(
    '/v1/admin/taxonomy.move',
    {
      onRequest: csrfUnlessBearer(app),
      schema: { body: MoveCategoryRequest, response: { 200: CategoryResponse } },
    },
    async (request) => {
      // Both ends of a move are checked, and the whole subtree that moves with
      // it: a branch-scoped administrator must not be able to move a category
      // out of their branch, into it, or take a restricted child along.
      const actor = await resolveWorkspaceActor(services, request);
      await services.authorization.require(actor.context, actor.standing, 'taxonomy.manage', {
        categoryIds: [
          ...(await subtreeOf(services, actor.context.workspaceId, request.body.category_id)),
          ...(request.body.new_parent_id ? [request.body.new_parent_id] : []),
        ],
      });
      const result = await services.taxonomy.move(
        actor.context,
        request.body.category_id,
        request.body.new_parent_id,
      );
      return { taxonomy_version: result.taxonomyVersion, category: summary(result.category) };
    },
  );

  r.post(
    '/v1/admin/taxonomy.merge',
    {
      onRequest: csrfUnlessBearer(app),
      schema: { body: MergeCategoryRequest, response: { 200: CategoryResponse } },
    },
    async (request) => {
      // Both ends, and everything under the category that closes: a merge
      // moves that whole subtree to the survivor, so a branch-scoped
      // administrator must not be able to push a branch they do not hold into
      // one they do, or take a restricted child along with it.
      const actor = await resolveWorkspaceActor(services, request);
      await services.authorization.require(actor.context, actor.standing, 'taxonomy.manage', {
        categoryIds: [
          ...(await subtreeOf(services, actor.context.workspaceId, request.body.category_id)),
          request.body.into_category_id,
        ],
      });
      const result = await services.taxonomy.merge(
        actor.context,
        request.body.category_id,
        request.body.into_category_id,
      );
      return { taxonomy_version: result.taxonomyVersion, category: summary(result.category) };
    },
  );

  r.post(
    '/v1/admin/taxonomy.restore',
    {
      onRequest: csrfUnlessBearer(app),
      schema: { body: RestoreCategoryRequest, response: { 200: CategoryResponse } },
    },
    async (request) => {
      // Restoring brings the whole subtree back, so it is checked against the
      // whole subtree, exactly as archiving is.
      const actor = await resolveWorkspaceActor(services, request);
      await services.authorization.require(actor.context, actor.standing, 'taxonomy.manage', {
        categoryIds: await subtreeOf(services, actor.context.workspaceId, request.body.category_id),
      });
      const result = await services.taxonomy.restore(actor.context, request.body.category_id);
      return { taxonomy_version: result.taxonomyVersion, category: summary(result.category) };
    },
  );

  r.post(
    '/v1/admin/taxonomy.archive',
    {
      onRequest: csrfUnlessBearer(app),
      schema: { body: ArchiveCategoryRequest, response: { 200: CategoryResponse } },
    },
    async (request) => {
      // Archiving takes the whole subtree with it.
      const actor = await resolveWorkspaceActor(services, request);
      await services.authorization.require(actor.context, actor.standing, 'taxonomy.manage', {
        categoryIds: await subtreeOf(services, actor.context.workspaceId, request.body.category_id),
      });
      const result = await services.taxonomy.archive(actor.context, request.body.category_id);
      return { taxonomy_version: result.taxonomyVersion, category: summary(result.category) };
    },
  );
}

/**
 * The tool handler, which the `GET` above and `POST /v1/taxonomy_list` both
 * call. The query string coerces its filters from strings and a tool call
 * sends real JSON, so the two schemas differ and the handler does not.
 */
export async function taxonomyList(
  services: Services,
  request: FastifyRequest,
  input: TaxonomyListInput,
): Promise<TaxonomyListResponse> {
  const actor = await requireListPermission(services, request, 'taxonomy.read');
  // The version is read first: reporting an older version with newer
  // categories is safe, the other way round makes a caching client stop
  // asking for changes it has not seen.
  const version = await services.taxonomy.currentVersion(actor.context.workspaceId);
  const categories = await services.taxonomy.list(actor.context.workspaceId, {
    rootPath: input.root_path,
    depth: input.depth,
    includeArchived: input.include_archived,
  });
  // A scoped grant shows its branch rather than the whole tree.
  const visible = await services.authorization.filter(
    actor.context,
    actor.standing,
    'taxonomy.read',
    categories,
    (category) => ({ categoryIds: [category.id] }),
  );
  return {
    taxonomy_version: version,
    categories: visible.map((c) => summary(c, input.include_guidance)),
  };
}

/**
 * Proposing a category.
 *
 * Three answers, and the interesting one is the first. An agent that wants a
 * category the tree already has should be told so and pointed at it, rather
 * than given a second one under a different name — which is how a taxonomy
 * stops being a taxonomy. A close-enough existing category is matched by
 * name, and the agent is told which and why.
 *
 * Otherwise policy decides, as it does for knowledge: a rule may let this
 * actor create categories outright, and without one the proposal waits
 * (rule 14). The proposal carries the reason and the example titles, because
 * a reviewer judging whether a category is needed judges it on those.
 */
export async function taxonomyPropose(
  services: Services,
  request: FastifyRequest,
  input: TaxonomyProposeInput,
): Promise<TaxonomyProposeResult> {
  const actor = await resolveWorkspaceActor(services, request);
  await services.authorization.require(actor.context, actor.standing, 'taxonomy.propose');
  const workspaceId = actor.context.workspaceId;

  const tree = await services.repositories.categories.list(workspaceId, {});
  const parent = input.parent_path ? tree.find((c) => c.path === input.parent_path) : undefined;
  if (input.parent_path && !parent) {
    throw new DomainError('NOT_FOUND', `no category at ${input.parent_path}`, {
      objectIds: { path: input.parent_path },
    });
  }

  // Somewhere the tree already has for this. Matching on the normalised name
  // under the same parent, because that is the collision a proposer makes:
  // "Data Sources" beside an existing "data sources".
  const normalised = input.name.trim().toLowerCase();
  const existing = tree.find(
    (c) =>
      c.name.trim().toLowerCase() === normalised && (c.parentId ?? null) === (parent?.id ?? null),
  );
  if (existing) {
    return {
      result: 'use_existing',
      category: await withAliases(services, workspaceId, existing),
      proposal_id: null,
      explanation: `${existing.path} already covers this; put the knowledge there rather than making a second category for it.`,
    };
  }

  const decision = await services.authorization.policyFor(
    actor.context,
    actor.standing,
    'taxonomy.create',
    parent ? { categoryIds: [parent.id] } : {},
  );
  if (decision === 'deny') {
    await services.authorization.recordDenied(
      actor.context,
      'taxonomy.create',
      'policy_deny',
      parent ? { categoryIds: [parent.id] } : {},
    );
    throw new DomainError('FORBIDDEN', 'policy refuses this category');
  }

  if (decision === 'allow_direct') {
    const created = await services.taxonomy.create(actor.context, {
      name: input.name,
      ...(input.parent_path ? { parentPath: input.parent_path } : {}),
      ...(input.description ? { description: input.description } : {}),
    });
    return {
      result: 'created',
      category: await withAliases(services, workspaceId, created.category),
      proposal_id: null,
      explanation: 'a policy rule allows you to create categories here.',
    };
  }

  const proposal = await services.proposals.proposeCategory(actor.context, actor.standing, {
    name: input.name,
    parentPath: input.parent_path,
    description: input.description,
    reason: input.reason,
    exampleTitles: input.example_titles,
    ...(parent ? { parentId: parent.id } : {}),
  });
  return {
    result: 'proposal_created',
    category: null,
    proposal_id: proposal.id,
    explanation:
      'recorded for review; put the knowledge in an existing category until somebody decides.',
  };
}

/** A category as the contract shows one, with the aliases it carries. */
async function withAliases(
  services: Services,
  workspaceId: WorkspaceId,
  category: CategoryRecord,
): Promise<CategorySummary> {
  const aliases = await services.repositories.aliases.listForWorkspace(workspaceId);
  const counts = await services.repositories.categories.itemCounts(workspaceId);
  return summary({
    ...category,
    aliases: aliases.filter((a) => a.categoryId === category.id).map((a) => a.alias),
    itemCount: counts.get(category.id)?.direct ?? 0,
    subtreeItemCount: counts.get(category.id)?.subtree ?? 0,
  });
}
