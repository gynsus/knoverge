import type { ScopeSelector } from '@knoverge/contracts';

import type { CategoryAncestors, Target } from './types.ts';

export const EMPTY_SCOPE: ScopeSelector = { categories: [], types: [], languages: [] };

/**
 * A scope matches a target when every dimension it constrains matches. An empty
 * dimension constrains nothing, so an empty selector matches the whole workspace.
 *
 * A target with no categories matches only a scope that does not constrain
 * categories: a grant limited to one branch must not cover uncategorised objects.
 */
export function scopeMatches(
  scope: ScopeSelector,
  target: Target,
  ancestorsOf: CategoryAncestors,
): boolean {
  if (scope.types.length > 0) {
    if (target.type === undefined || !scope.types.includes(target.type as never)) return false;
  }
  if (scope.languages.length > 0) {
    if (target.language === undefined || !scope.languages.includes(target.language)) return false;
  }
  if (scope.categories.length === 0) return true;

  const targetCategories = target.categoryIds ?? [];
  if (targetCategories.length === 0) return false;
  // Every category the object belongs to must be covered, so an object filed in
  // a permitted and a restricted branch is not reachable through the permitted one.
  return targetCategories.every((categoryId) =>
    scope.categories.some((entry) =>
      entry.category_id === categoryId
        ? true
        : entry.include_descendants && ancestorsOf(categoryId).includes(entry.category_id),
    ),
  );
}
