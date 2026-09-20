import { z } from 'zod';

import { CategoryId, WorkspaceId } from './ids.ts';

export const CategoryStatus = z.enum(['proposed', 'active', 'merged', 'archived', 'rejected']);
export type CategoryStatus = z.infer<typeof CategoryStatus>;

/** One path segment: lower-case letters, digits and hyphens. */
export const CategorySlug = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'lower-case letters, digits and hyphens');

/** Slash-joined chain of slugs, for example projects/pixel-brisbane/architecture. */
export const CategoryPath = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  .regex(
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/,
    'slash-joined lower-case slugs',
  );

export const CategoryName = z.string().trim().min(1).max(120);
export const CategoryAlias = z.string().trim().min(1).max(120);
export const Guidance = z.array(z.string().trim().min(1).max(500)).max(50);

export const CategorySummary = z.object({
  id: CategoryId,
  workspace_id: WorkspaceId,
  parent_id: CategoryId.nullable(),
  slug: CategorySlug,
  path: CategoryPath,
  name: CategoryName,
  description: z.string().nullable(),
  inclusion_guidance: z.array(z.string()),
  exclusion_guidance: z.array(z.string()),
  aliases: z.array(CategoryAlias),
  status: CategoryStatus,
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
  /** Items directly in this category. Always 0 until knowledge items exist. */
  item_count: z.number().int().nonnegative(),
  /** Items in this category and its descendants. */
  subtree_item_count: z.number().int().nonnegative(),
});
export type CategorySummary = z.infer<typeof CategorySummary>;

export const TaxonomyListQuery = z.object({
  root_path: CategoryPath.optional(),
  depth: z.coerce.number().int().min(1).max(20).optional(),
  include_archived: z.stringbool().default(false),
  include_guidance: z.stringbool().default(true),
});
export type TaxonomyListQuery = z.infer<typeof TaxonomyListQuery>;

export const TaxonomyListResponse = z.object({
  taxonomy_version: z.number().int().nonnegative(),
  categories: z.array(CategorySummary),
});
export type TaxonomyListResponse = z.infer<typeof TaxonomyListResponse>;

export const CreateCategoryRequest = z.object({
  name: CategoryName,
  /** Retry-safe: the same key with the same body returns the first result. */
  idempotency_key: z.string().optional(),
  /** Omit for a root category. */
  parent_path: CategoryPath.optional(),
  slug: CategorySlug.optional(),
  description: z.string().trim().max(2000).optional(),
  inclusion_guidance: Guidance.optional(),
  exclusion_guidance: Guidance.optional(),
  aliases: z.array(CategoryAlias).max(20).optional(),
});
export type CreateCategoryRequest = z.infer<typeof CreateCategoryRequest>;

export const UpdateCategoryRequest = z.object({
  category_id: CategoryId,
  name: CategoryName.optional(),
  slug: CategorySlug.optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  inclusion_guidance: Guidance.optional(),
  exclusion_guidance: Guidance.optional(),
  aliases: z.array(CategoryAlias).max(20).optional(),
});
export type UpdateCategoryRequest = z.infer<typeof UpdateCategoryRequest>;

export const MoveCategoryRequest = z.object({
  category_id: CategoryId,
  /** New parent, or null to make the category a root. */
  new_parent_id: CategoryId.nullable(),
});
export type MoveCategoryRequest = z.infer<typeof MoveCategoryRequest>;

export const ArchiveCategoryRequest = z.object({ category_id: CategoryId });
export type ArchiveCategoryRequest = z.infer<typeof ArchiveCategoryRequest>;

/**
 * Brings an archived category and its descendants back.
 *
 * The whole subtree returns, because that is what archiving took. A category
 * archived on its own before its parent was archived therefore comes back with
 * the parent: nothing records why something was archived, and reviving too
 * much is visible and correctable, while reviving too little leaves an
 * operator clicking through a branch one node at a time.
 */
export const RestoreCategoryRequest = z.object({ category_id: CategoryId });
export type RestoreCategoryRequest = z.infer<typeof RestoreCategoryRequest>;

export const CategoryResponse = z.object({
  taxonomy_version: z.number().int().nonnegative(),
  category: CategorySummary,
});
export type CategoryResponse = z.infer<typeof CategoryResponse>;
