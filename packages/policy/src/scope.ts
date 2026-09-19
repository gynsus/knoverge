import type { ScopeSelector } from '@knoverge/contracts';

import type { CategoryAncestors, Target } from './types.ts';

export const EMPTY_SCOPE: ScopeSelector = { categories: [], types: [], languages: [] };

/**
 * How many of a target's categories a scope has to cover.
 *
 * `all` is what an allow needs: a grant limited to one branch does not authorise
 * a request that also touches another. `any` is what a deny needs: a
 * restriction on one branch must fire on a request that touches it, whatever
 * else the request touches. Requiring `all` for a deny meant a branch deny was
 * bypassed by renaming or archiving the parent, because the parent is not in
 * the denied branch and the operation was judged to fall outside it.
 */
export type ScopeCoverage = 'all' | 'any';

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
  coverage: ScopeCoverage = 'all',
): boolean {
  if (scope.types.length > 0) {
    const types: readonly string[] = scope.types;
    if (target.type === undefined || !types.includes(target.type)) return false;
  }
  if (scope.languages.length > 0) {
    if (target.language === undefined || !scope.languages.includes(target.language)) return false;
  }
  if (scope.categories.length === 0) return true;

  const targetCategories = target.categoryIds ?? [];
  if (targetCategories.length === 0) return false;
  const covers = (categoryId: string) =>
    scope.categories.some((entry) =>
      entry.category_id === categoryId
        ? true
        : entry.include_descendants && ancestorsOf(categoryId).includes(entry.category_id),
    );
  // An allow must cover every category the request touches, so an object filed
  // in a permitted and a restricted branch is not reachable through the
  // permitted one. A deny fires as soon as it covers one of them.
  return coverage === 'all' ? targetCategories.every(covers) : targetCategories.some(covers);
}
