import type { CategorySummary } from '@knoverge/contracts';

export interface CategoryNode {
  category: CategorySummary;
  children: CategoryNode[];
}

/** Depth of a path, counting from zero for a root. */
export function depthOf(path: string): number {
  return path.split('/').length - 1;
}

/**
 * A tree from the flat list the server sends.
 *
 * Built from `parent_id` rather than from the path, because the path is a
 * name and the parent is the relationship. Anything whose parent is missing
 * from the list — a child of an archived category when archived ones are
 * filtered out — becomes a root, so nothing silently disappears.
 */
export function buildTree(categories: readonly CategorySummary[]): CategoryNode[] {
  const nodes = new Map<string, CategoryNode>();
  for (const category of categories) nodes.set(category.id, { category, children: [] });
  const roots: CategoryNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.category.parent_id ? nodes.get(node.category.parent_id) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sort = (list: CategoryNode[]) => {
    list.sort((a, b) => a.category.name.localeCompare(b.category.name));
    for (const node of list) sort(node.children);
  };
  sort(roots);
  return roots;
}

/**
 * Whether a category answers a search, and on what.
 *
 * Name, path, aliases and description, because a curated taxonomy carries
 * most of its meaning outside the name: somebody looking for "auth" should
 * find a category called Architecture whose guidance mentions authentication.
 */
export function matchOf(
  category: CategorySummary,
  needle: string,
): 'name' | 'path' | 'alias' | 'description' | null {
  if (needle === '') return null;
  if (category.name.toLowerCase().includes(needle)) return 'name';
  if (category.path.toLowerCase().includes(needle)) return 'path';
  if (category.aliases.some((a) => a.toLowerCase().includes(needle))) return 'alias';
  if ((category.description ?? '').toLowerCase().includes(needle)) return 'description';
  return null;
}

/**
 * Every category a search should keep on screen: the matches, and each
 * match's ancestors.
 *
 * Without the ancestors a match three levels down has nothing to hang from
 * and the tree becomes a flat list that has lost the one thing it was for.
 */
export function matching(
  categories: readonly CategorySummary[],
  query: string,
): { visible: Set<string>; matched: Set<string> } {
  const needle = query.trim().toLowerCase();
  const matched = new Set<string>();
  const visible = new Set<string>();
  if (needle === '') return { visible, matched };
  const byId = new Map(categories.map((c) => [c.id, c]));
  for (const category of categories) {
    if (matchOf(category, needle) === null) continue;
    matched.add(category.id);
    let walk: CategorySummary | undefined = category;
    while (walk) {
      if (visible.has(walk.id)) break;
      visible.add(walk.id);
      walk = walk.parent_id ? byId.get(walk.parent_id) : undefined;
    }
  }
  return { visible, matched };
}

/** The ids of everything below a category, and the category itself. */
export function subtreeIds(
  categories: readonly CategorySummary[],
  category: CategorySummary,
): string[] {
  return categories
    .filter((c) => c.path === category.path || c.path.startsWith(`${category.path}/`))
    .map((c) => c.id);
}
