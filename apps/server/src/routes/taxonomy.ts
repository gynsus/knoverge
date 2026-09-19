import {
  ArchiveCategoryRequest,
  CategoryResponse,
  CreateCategoryRequest,
  MoveCategoryRequest,
  TaxonomyListQuery,
  TaxonomyListResponse,
  UpdateCategoryRequest,
  type CategorySummary,
} from '@knoverge/contracts';
import type { CategoryWithAliases } from '@knoverge/core';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import {
  idempotencyKey,
  requireListPermission,
  resolveWorkspaceActor,
  requirePermission,
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
    // Knowledge items arrive in Milestone 2; the counts are part of the contract already.
    item_count: 0,
    subtree_item_count: 0,
  };
}

/**
 * Reads require taxonomy.read, mutations taxonomy.manage. Both come from the
 * caller's role or trust tier by default and can be granted explicitly.
 */
export function registerTaxonomyRoutes(app: FastifyInstance, services: Services): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/v1/taxonomy.list',
    { schema: { querystring: TaxonomyListQuery, response: { 200: TaxonomyListResponse } } },
    async (request) => {
      const actor = await requireListPermission(services, request, 'taxonomy.read');
      const query = request.query;
      // The version is read first: reporting an older version with newer
      // categories is safe, the other way round makes a caching client stop
      // asking for changes it has not seen.
      const version = await services.taxonomy.currentVersion(actor.context.workspaceId);
      const categories = await services.taxonomy.list(actor.context.workspaceId, {
        rootPath: query.root_path,
        depth: query.depth,
        includeArchived: query.include_archived,
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
        categories: visible.map((c) => summary(c, query.include_guidance)),
      };
    },
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
      const actor = await requirePermission(services, request, 'taxonomy.manage', {
        categoryIds: [body.category_id],
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
      // Both ends of a move are checked: a branch-scoped administrator must
      // not be able to move a category out of their branch or into it.
      const actor = await requirePermission(services, request, 'taxonomy.manage', {
        categoryIds: [
          request.body.category_id,
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
    '/v1/admin/taxonomy.archive',
    {
      onRequest: csrfUnlessBearer(app),
      schema: { body: ArchiveCategoryRequest, response: { 200: CategoryResponse } },
    },
    async (request) => {
      const actor = await requirePermission(services, request, 'taxonomy.manage', {
        categoryIds: [request.body.category_id],
      });
      const result = await services.taxonomy.archive(actor.context, request.body.category_id);
      return { taxonomy_version: result.taxonomyVersion, category: summary(result.category) };
    },
  );
}
