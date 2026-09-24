/**
 * The constant that decides how much a rank is worth.
 *
 * Reciprocal rank fusion scores a result as `1 / (k + rank)`. A larger `k`
 * flattens the curve, so the tenth hit of one list is worth nearly as much as
 * the first; a smaller one makes the top of each list dominate. Sixty is the
 * value the method was published with and the one most implementations use,
 * and nothing here has the evidence to justify a different number.
 */
export const RRF_K = 60;

/**
 * What each opinion is worth.
 *
 * Equal, deliberately. Lexical retrieval is exact and brittle — it finds the
 * word or it does not; vector retrieval is approximate and never empty, which
 * means it always has an opinion including when it has no business having one.
 * Weighting either above the other is a claim about a corpus this does not
 * have.
 */
export const LEXICAL_WEIGHT = 1;
export const SEMANTIC_WEIGHT = 1;

/** One ranked list, best first. Ids are chunk ids. */
export type Ranking = readonly string[];

export interface Fused {
  id: string;
  /** The fused score. Comparable within one search and no other. */
  score: number;
  /** Which lists had it, for a caller that wants to say why. */
  lexicalRank: number | null;
  semanticRank: number | null;
}

/**
 * Combines two rankings by position rather than by score.
 *
 * The scores cannot be added: `ts_rank_cd` has no ceiling and moves with the
 * corpus, cosine similarity is bounded and moves with the model. Normalising
 * each to its own result set and adding them looks reasonable and quietly
 * makes the weighting depend on how many results came back.
 *
 * Positions have none of that. What a result is worth depends on where it came
 * in its own list, which is the only thing the two lists agree about.
 */
export function fuse(lexical: Ranking, semantic: Ranking): Fused[] {
  const scores = new Map<string, Fused>();

  const add = (ids: Ranking, weight: number, which: 'lexicalRank' | 'semanticRank') => {
    ids.forEach((id, index) => {
      const rank = index + 1;
      const entry = scores.get(id) ?? { id, score: 0, lexicalRank: null, semanticRank: null };
      entry.score += weight / (RRF_K + rank);
      entry[which] = rank;
      scores.set(id, entry);
    });
  };

  add(lexical, LEXICAL_WEIGHT, 'lexicalRank');
  add(semantic, SEMANTIC_WEIGHT, 'semanticRank');

  return [...scores.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

/**
 * Keeps each item's best chunk, in the order the chunks came.
 *
 * An item is as good as its best chunk, never as good as the sum of them:
 * summing hands every query to the longest document, which has more chances to
 * contain the words by having more words.
 */
export function bestPerItem<T>(ordered: readonly T[], itemOf: (candidate: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const candidate of ordered) {
    const item = itemOf(candidate);
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(candidate);
  }
  return out;
}
