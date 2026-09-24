import type { CategorySummary, ProposalDetail } from '@knoverge/contracts';

/** What a category proposal carries, read the way the payload stores it. */
export interface ProposedPayload {
  name: string;
  parentPath: string | null;
  description: string | null;
  /** What the proposer would file here, which is the case for the category. */
  exampleTitles: string[];
}

export function payloadOf(proposal: ProposalDetail): ProposedPayload {
  const payload = (proposal.proposed_payload ?? {}) as Record<string, unknown>;
  const examples = payload['exampleTitles'];
  return {
    name: String(payload['name'] ?? ''),
    parentPath: typeof payload['parentPath'] === 'string' ? payload['parentPath'] : null,
    description: typeof payload['description'] === 'string' ? payload['description'] : null,
    exampleTitles: Array.isArray(examples) ? examples.map(String) : [],
  };
}

/**
 * Categories whose names are close to the proposed one.
 *
 * By name, and said so: the duplicate machinery compares knowledge by meaning,
 * and nothing does that for categories. A shared word is a weaker signal than
 * a vector, and claiming otherwise would be the wrong kind of help — but
 * "Data Providers" arriving next to "Data Sources" is exactly the collision
 * this view exists to catch, and a shared word finds it.
 */
export function similarTo(name: string, categories: readonly CategorySummary[]): CategorySummary[] {
  const words = new Set(
    name
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 2),
  );
  if (words.size === 0) return [];
  return categories
    .filter((category) =>
      category.name
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .some((word) => words.has(word)),
    )
    .slice(0, 5);
}
