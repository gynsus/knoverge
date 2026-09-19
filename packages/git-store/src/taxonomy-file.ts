import { stringify } from 'yaml';

/** A category as the repository records it. */
export interface TaxonomyNode {
  slug: string;
  name: string;
  status: string;
  description?: string | null;
  aliases?: string[];
  inclusion_guidance?: string[];
  exclusion_guidance?: string[];
  children?: TaxonomyNode[];
}

export interface TaxonomyFile {
  version: number;
  updated_at: string;
  categories: TaxonomyNode[];
}

export const TAXONOMY_PATH = 'taxonomy.yaml';

/** A flat category, as PostgreSQL holds it. */
export interface FlatCategory {
  path: string;
  slug: string;
  name: string;
  status: string;
  description: string | null;
  aliases: string[];
  inclusionGuidance: string[];
  exclusionGuidance: string[];
}

/**
 * Renders the whole tree, rewritten in the same commit as any taxonomy change
 * (GIT_REPOSITORY.md section 6).
 *
 * Empty fields are left out rather than written as null, because the file is
 * meant to be read by a person and a page of nulls is not.
 */
export function renderTaxonomy(
  categories: readonly FlatCategory[],
  version: number,
  updatedAt: Date,
): string {
  const byPath = new Map<string, TaxonomyNode>();
  const roots: TaxonomyNode[] = [];
  // Sorted by path, so a parent is always built before its children.
  for (const category of [...categories].sort((a, b) => a.path.localeCompare(b.path))) {
    const node: TaxonomyNode = {
      slug: category.slug,
      name: category.name,
      status: category.status,
      ...(category.description ? { description: category.description } : {}),
      ...(category.aliases.length > 0 ? { aliases: category.aliases } : {}),
      ...(category.inclusionGuidance.length > 0
        ? { inclusion_guidance: category.inclusionGuidance }
        : {}),
      ...(category.exclusionGuidance.length > 0
        ? { exclusion_guidance: category.exclusionGuidance }
        : {}),
    };
    byPath.set(category.path, node);
    const cut = category.path.lastIndexOf('/');
    const parent = cut === -1 ? undefined : byPath.get(category.path.slice(0, cut));
    if (parent) {
      parent.children ??= [];
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const file: TaxonomyFile = {
    version,
    updated_at: updatedAt.toISOString(),
    categories: roots,
  };
  return stringify(file, { lineWidth: 0 });
}

/** The README written once into a new workspace repository. */
export function renderReadme(workspaceName: string): string {
  return `# ${workspaceName}

This repository is managed by Knoverge. It is the canonical copy of this
workspace's knowledge, and it is meant to be readable without the application.

## Layout

    taxonomy.yaml            the category tree
    knowledge/<category path>/<item>.md

Each item is Markdown with YAML frontmatter. The frontmatter references
categories by slug path, never by database id, so the tree above and the files
below describe each other.

## Editing

Editing this repository directly is not supported. Knoverge treats an
unexpected HEAD as an integrity error and refuses to write to the workspace
until an operator has looked at it.

## What is here, and what is not

Here: the knowledge, its metadata, the taxonomy, and the history of both.

Not here: users, permissions, policy, proposals, review decisions, sync state
and the audit ledger. Those live in PostgreSQL. A full restore needs both.
`;
}
