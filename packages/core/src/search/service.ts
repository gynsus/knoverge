import type { WorkspaceId } from '@knoverge/contracts';
import type { EmbeddingSource } from '@knoverge/intelligence';
import { bestPerItem, fuse } from '@knoverge/search';

import type { EmbeddingService } from '../embeddings/service.ts';
import type { SearchCandidate, SearchHit, SearchQuery, SearchRepository } from './repository.ts';

/**
 * How many chunks each ranking offers the fusion.
 *
 * Wider than what the caller asked for, because fusion is the point: a chunk
 * that came ninth lexically and second semantically should be able to reach
 * the top, and it cannot if the lexical list stopped at five.
 */
export const CANDIDATE_POOL = 60;

export interface SearchServiceOptions {
  search: SearchRepository;
  embeddings: EmbeddingService;
  /**
   * Embeds the query, when anything does.
   *
   * A question rather than a provider held since start-up: an operator
   * connects one while the product runs (ADR 0021), and nothing configured
   * stays the default answer.
   */
  source: EmbeddingSource;
  /** Told when the semantic half failed, so it can be logged rather than raised. */
  onSemanticFailure?: (workspaceId: WorkspaceId, error: unknown) => void;
}

/**
 * Finding knowledge: the lexical ranking, the semantic one, and the rule that
 * puts them together.
 *
 * Both halves are optional in one direction only. Lexical always answers.
 * Semantic answers when a provider is configured and a profile is active, and
 * when it cannot — no provider, nothing embedded yet, the provider is down —
 * the search is the lexical one. A search that failed because an optional
 * feature was unavailable would make the feature mandatory (rule 9).
 */
export class SearchService {
  private readonly o: SearchServiceOptions;

  constructor(options: SearchServiceOptions) {
    this.o = options;
  }

  async find(query: SearchQuery): Promise<SearchHit[]> {
    const limit = Math.min(query.limit ?? 20, 100);
    const pool = Math.max(CANDIDATE_POOL, limit);
    const lexical = await this.o.search.lexical(query, pool);
    const semantic = await this.semantic(query, pool);

    // Nothing to fuse: the lexical ranking is the answer, and its own score
    // is what orders it.
    const ordered =
      semantic.length === 0
        ? lexical.map((candidate) => ({ ...candidate, score: candidate.components.lexical }))
        : reorder([...lexical, ...semantic], fuse(ids(lexical), ids(semantic)));

    const chosen = bestPerItem(ordered, (candidate) => candidate.itemId).slice(0, limit);
    // The best hit of a search scores 1 and the rest fall away from it. A
    // fused score has no meaning outside its own search, and an absolute
    // number would invite comparing two searches.
    const best = Math.max(...chosen.map((hit) => hit.score), Number.EPSILON);
    return chosen.map((candidate) => ({ ...candidate, score: candidate.score / best }));
  }

  /** The semantic half, or nothing at all when it cannot answer. */
  private async semantic(query: SearchQuery, pool: number): Promise<SearchCandidate[]> {
    const provider = await this.o.source();
    if (!provider) return [];
    const profile = await this.o.embeddings.activeProfile(query.workspaceId);
    if (!profile) return [];
    try {
      const [vector] = await provider.embed([query.text]);
      if (!vector) return [];
      return await this.o.search.semantic(query, vector, profile.id, pool);
    } catch (error) {
      // The provider is somebody else's server. A search that failed because
      // it was down would make an optional feature mandatory.
      this.o.onSemanticFailure?.(query.workspaceId, error);
      return [];
    }
  }
}

const ids = (candidates: readonly SearchCandidate[]): string[] =>
  candidates.map((candidate) => candidate.chunkId);

/** The candidates in the fused order, each one kept once. */
function reorder(
  candidates: readonly SearchCandidate[],
  fused: readonly { id: string; score: number }[],
): SearchCandidate[] {
  const byChunk = new Map(candidates.map((candidate) => [candidate.chunkId, candidate]));
  const out: SearchCandidate[] = [];
  for (const entry of fused) {
    const candidate = byChunk.get(entry.id);
    if (candidate) out.push({ ...candidate, score: entry.score });
  }
  return out;
}
