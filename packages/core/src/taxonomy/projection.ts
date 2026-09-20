import type { CategoryId } from '@knoverge/contracts';

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

/** The tree with a subtree archived. */
export function withArchivedSubtree(
  categories: readonly CategoryRecord[],
  path: string,
): CategoryRecord[] {
  return categories.map((category) =>
    inSubtree(category.path, path) ? { ...category, status: 'archived' as const } : category,
  );
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
