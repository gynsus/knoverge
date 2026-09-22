import type { KnowledgeItemId, WorkspaceId } from '@knoverge/contracts';

/** Just enough of the knowledge index to move files with their category. */
export interface ItemFileLookup {
  pathsUnderDirectory(
    workspaceId: WorkspaceId,
    directory: string,
  ): Promise<{ id: KnowledgeItemId; slug: string; markdownPath: string }[]>;
  slugsInDirectory(workspaceId: WorkspaceId, directory: string): Promise<string[]>;
}

/** Where one item's file is going, and under what name. */
export interface PlannedMove {
  id: KnowledgeItemId;
  slug: string;
  from: string;
  to: string;
}

/** Where knowledge files live, under their category's path. */
export const KNOWLEDGE_DIRECTORY = 'knowledge';

/**
 * Which files a set of category path changes moves, and where to.
 *
 * Knowledge lives at `knowledge/<category path>/<slug>.md`, so one prefix
 * covers a whole branch: the category's own items and every descendant's
 * (ADR 0016).
 *
 * Deliberately free of the repository. It reads the index and does path
 * arithmetic, nothing else, so the same call answers the same way before a
 * change and again on a replay of it — which is what lets recovery finish a
 * move whose files are already committed by asking for the plan a second time.
 *
 * A slug already taken at the destination gets a new one, the same rule
 * creation uses when two items would collide in a directory. An item's
 * identity is the id in its frontmatter; the slug is the file name.
 */
export async function planRelocation(
  deps: {
    items: ItemFileLookup;
    uniqueSlug: (wanted: string, taken: ReadonlySet<string>) => string;
  },
  workspaceId: WorkspaceId,
  changes: readonly { from: string; to: string }[],
): Promise<PlannedMove[]> {
  const planned: PlannedMove[] = [];
  for (const change of changes) {
    if (change.from === change.to) continue;
    const fromDirectory = `${KNOWLEDGE_DIRECTORY}/${change.from}`;
    const toDirectory = `${KNOWLEDGE_DIRECTORY}/${change.to}`;
    // Ordered by path in the index, so the order two colliding slugs are
    // resolved in does not depend on the database's mood.
    const items = await deps.items.pathsUnderDirectory(workspaceId, fromDirectory);
    if (items.length === 0) continue;

    const taken = new Set(await deps.items.slugsInDirectory(workspaceId, toDirectory));
    for (const item of items) {
      const rest = item.markdownPath.slice(fromDirectory.length + 1);
      const directory = rest.includes('/')
        ? `${toDirectory}/${rest.slice(0, rest.lastIndexOf('/'))}`
        : toDirectory;
      const slug = deps.uniqueSlug(item.slug, taken);
      taken.add(slug);
      planned.push({
        id: item.id,
        slug,
        from: item.markdownPath,
        to: `${directory}/${slug}.md`,
      });
    }
  }
  return planned;
}

/** A category path rewritten onto one of an item's category paths. */
export function rewriteCategoryPath(path: string, change: { from: string; to: string }): string {
  return path === change.from || path.startsWith(`${change.from}/`)
    ? `${change.to}${path.slice(change.from.length)}`
    : path;
}
