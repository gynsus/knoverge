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

import { requirePermission } from '../plugins/actor-context.ts';
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
      const actor = await requirePermission(services, request, 'taxonomy.read');
      const query = request.query;
      const categories = await services.taxonomy.list(actor.context.workspaceId, {
        rootPath: query.root_path,
        depth: query.depth,
        includeArchived: query.include_archived,
      });
      return {
        taxonomy_version: await services.taxonomy.currentVersion(actor.context.workspaceId),
        categories: categories.map((c) => summary(c, query.include_guidance)),
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
      const actor = await requirePermission(services, request, 'taxonomy.manage');
      const body = request.body;
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

  r.post(
    '/v1/admin/taxonomy.update',
    {
      onRequest: csrfUnlessBearer(app),
      schema: { body: UpdateCategoryRequest, response: { 200: CategoryResponse } },
    },
    async (request) => {
      const actor = await requirePermission(services, request, 'taxonomy.manage');
      const body = request.body;
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
      const actor = await requirePermission(services, request, 'taxonomy.manage');
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
      const actor = await requirePermission(services, request, 'taxonomy.manage');
      const result = await services.taxonomy.archive(actor.context, request.body.category_id);
      return { taxonomy_version: result.taxonomyVersion, category: summary(result.category) };
    },
  );
}
