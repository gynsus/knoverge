import type { CategoryId, CategoryStatus } from '@knoverge/contracts';

import type { CategoryRecord } from './repository.ts';

/**
 * What the category tree will look like once a change is applied.
 *
 * The repository file is committed before PostgreSQL is written, because
 * recovery relies on Git going first: a revision without a commit is
 * impossible by construction, and a commit without a revision is repairable.
 * So the file has to be rendered from a tree that does not exist in the
 * database yet, which is what these build.
 *
 * They are a second implementation of what the SQL statements do, and two
 * implementations of one rule drift. `taxonomy-projection.test.ts` pins them
 * together: every mutation is applied to a real database and the result is
 * compared with what these return.
 */

/** The tree with one category added. */
export function withCategory(
  categories: readonly CategoryRecord[],
  added: CategoryRecord,
): CategoryRecord[] {
  return [...categories, added];
}

/** The tree with one category's fields changed, and its subtree's paths rewritten. */
export function withUpdate(
  categories: readonly CategoryRecord[],
  categoryId: CategoryId,
  patch: Partial<CategoryRecord>,
  paths?: { from: string; to: string },
): CategoryRecord[] {
  return categories.map((category) => {
    const rewritten = paths ? rewrite(category, paths.from, paths.to) : category;
    return rewritten.id === categoryId ? { ...rewritten, ...patch } : rewritten;
  });
}

/** The tree with a subtree moved under a new path. */
export function withMove(
  categories: readonly CategoryRecord[],
  categoryId: CategoryId,
  parentId: CategoryId | null,
  paths: { from: string; to: string },
): CategoryRecord[] {
  return categories.map((category) => {
    const rewritten = rewrite(category, paths.from, paths.to);
    return rewritten.id === categoryId ? { ...rewritten, parentId } : rewritten;
  });
}

/**
 * The tree with one status swapped for another across a subtree.
 *
 * Only the status named in `from` moves, so archiving and restoring are exact
 * inverses and neither touches a category a reviewer left `rejected` or a merge
 * left `merged`.
 */
export function withSubtreeStatus(
  categories: readonly CategoryRecord[],
  path: string,
  from: CategoryStatus,
  to: CategoryStatus,
): CategoryRecord[] {
  return categories.map((category) =>
    inSubtree(category.path, path) && category.status === from
      ? { ...category, status: to }
      : category,
  );
}

/**
 * One order for aliases.
 *
 * The file is rendered from the projection and the database returns its own
 * order, so without a shared comparator the file a change commits is not the
 * file a re-render of the database produces: an integrity check would flag
 * every alias write, and the next unrelated commit would carry a spurious diff
 * re-sorting somebody else's aliases.
 */
export function sortedAliases(aliases: readonly string[]): string[] {
  return [...aliases].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The tree with one category folded into another.
 *
 * The closed category keeps its own path, because its path becomes an alias
 * of the survivor and an alias pointing at a path that moved would point
 * nowhere. Everything below it moves: a descendant's path swaps the closed
 * category's prefix for the survivor's, and what were direct children become
 * direct children of the survivor.
 */
export function withMerge(
  categories: readonly CategoryRecord[],
  source: CategoryRecord,
  target: CategoryRecord,
): CategoryRecord[] {
  return categories.map((category) => {
    if (category.id === source.id) {
      return { ...category, status: 'merged' as const, mergedIntoCategoryId: target.id };
    }
    if (!category.path.startsWith(`${source.path}/`)) return category;
    return {
      ...category,
      path: `${target.path}${category.path.slice(source.path.length)}`,
      ...(category.parentId === source.id ? { parentId: target.id } : {}),
    };
  });
}

/** The ids a subtree change touches, which is what the event records. */
export function subtreeIds(
  categories: readonly CategoryRecord[],
  path: string,
  when: (category: CategoryRecord) => boolean = () => true,
): CategoryId[] {
  return categories.filter((c) => inSubtree(c.path, path) && when(c)).map((c) => c.id);
}

function inSubtree(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function rewrite(category: CategoryRecord, from: string, to: string): CategoryRecord {
  if (!inSubtree(category.path, from)) return category;
  return { ...category, path: `${to}${category.path.slice(from.length)}` };
}
