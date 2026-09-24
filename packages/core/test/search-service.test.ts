import { describe, expect, it, vi } from 'vitest';

import type { WorkspaceId } from '@knoverge/contracts';
import { fixedSource, type EmbeddingProvider } from '@knoverge/intelligence';

import { SearchService } from '../src/search/service.ts';
import type { SearchCandidate, SearchQuery, SearchRepository } from '../src/search/repository.ts';

const workspaceId = 'ws_01M2XSEARCHSEARCHSEARCH01' as WorkspaceId;
const query: SearchQuery = { workspaceId, text: 'ledger key' };

/** A chunk, with only the fields the fusion and the fold look at. */
function candidate(chunkId: string, itemId: string, lexical = 1): SearchCandidate {
  return {
    chunkId,
    itemId: itemId as SearchCandidate['itemId'],
    markdownPath: `knowledge/_uncategorised/${chunkId}.md`,
    title: chunkId,
    type: 'fact',
    status: 'active',
    language: 'en',
    reviewState: 'unreviewed',
    evidenceState: 'none',
    disputed: false,
    revisionId: 'rev_01M2XSEARCHSEARCHSEARCH01' as SearchCandidate['revisionId'],
    contentHash: 'sha256:x',
    updatedAt: new Date(),
    score: 0,
    components: { lexical, title: 0, semantic: null },
    chunkOrdinal: 0,
    snippet: null,
  };
}

function repository(
  lexical: SearchCandidate[],
  semantic: SearchCandidate[] = [],
): SearchRepository & { semanticCalls: number } {
  let semanticCalls = 0;
  const repo = {
    upsert: async () => undefined,
    remove: async () => undefined,
    lexical: async () => lexical,
    semantic: async () => {
      semanticCalls += 1;
      return semantic;
    },
    countFor: async () => 0,
    indexedIds: async () => new Set<string>(),
    bodiesFor: async () => new Map(),
    get semanticCalls() {
      return semanticCalls;
    },
  };
  return repo as unknown as SearchRepository & { semanticCalls: number };
}

const embeddings = (active: boolean) =>
  ({
    activeProfile: async () => (active ? { id: 'eprof_1' } : null),
  }) as never;

const provider = (impl?: () => Promise<number[][]>): EmbeddingProvider => ({
  profile: { provider: 'stub', model: 'm', dimensions: 3 },
  embed: impl ?? (async () => [[1, 0, 0]]),
});

describe('with no embedding provider', () => {
  it('answers lexically, and never asks for a vector', async () => {
    const repo = repository([candidate('c1', 'i1', 5), candidate('c2', 'i2', 2)]);
    const service = new SearchService({
      search: repo,
      embeddings: embeddings(true),
      source: fixedSource(null),
    });

    const hits = await service.find(query);
    expect(hits.map((h) => h.itemId)).toEqual(['i1', 'i2']);
    // The best of this search scores 1 and the rest fall away from it.
    expect(hits[0]?.score).toBe(1);
    expect(hits[1]?.score).toBeCloseTo(0.4, 10);
    expect(repo.semanticCalls).toBe(0);
  });

  it('answers lexically when nothing has been embedded yet', async () => {
    // Configured but not finished: a client told semantic search was
    // available would stop searching lexically.
    const repo = repository([candidate('c1', 'i1')]);
    const service = new SearchService({
      search: repo,
      embeddings: embeddings(false),
      source: fixedSource(provider()),
    });
    expect(await service.find(query)).toHaveLength(1);
    expect(repo.semanticCalls).toBe(0);
  });
});

describe('with both halves', () => {
  it('lets a passage only the vectors found reach the answer', async () => {
    // The point of the second opinion: a passage that means the right thing
    // without containing the words.
    const repo = repository([candidate('c1', 'i1')], [candidate('c9', 'i9')]);
    const service = new SearchService({
      search: repo,
      embeddings: embeddings(true),
      source: fixedSource(provider()),
    });
    const hits = await service.find(query);
    expect(hits.map((h) => h.itemId).sort()).toEqual(['i1', 'i9']);
  });

  it('puts what both found above what only one did', async () => {
    const repo = repository(
      [candidate('a', 'ia'), candidate('b', 'ib')],
      [candidate('c', 'ic'), candidate('b', 'ib')],
    );
    const service = new SearchService({
      search: repo,
      embeddings: embeddings(true),
      source: fixedSource(provider()),
    });
    expect((await service.find(query))[0]?.itemId).toBe('ib');
  });

  it('keeps one chunk per item, the best one', async () => {
    // Two passages of the same item are one answer. Letting both through
    // would spend the page on a single document.
    const repo = repository([candidate('c1', 'i1'), candidate('c2', 'i1')]);
    const service = new SearchService({
      search: repo,
      embeddings: embeddings(true),
      source: fixedSource(provider()),
    });
    const hits = await service.find(query);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.title).toBe('c1');
  });

  it('answers lexically when the provider is down, and says so once', async () => {
    // A search that failed because an optional feature was unavailable would
    // make the feature mandatory (rule 9).
    const told = vi.fn();
    const repo = repository([candidate('c1', 'i1')], [candidate('c9', 'i9')]);
    const service = new SearchService({
      search: repo,
      embeddings: embeddings(true),
      source: fixedSource(
        provider(async () => {
          throw new Error('connection refused');
        }),
      ),
      onSemanticFailure: told,
    });

    const hits = await service.find(query);
    expect(hits.map((h) => h.itemId)).toEqual(['i1']);
    expect(told).toHaveBeenCalledTimes(1);
  });
});
