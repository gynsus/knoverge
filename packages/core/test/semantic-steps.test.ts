import { describe, expect, it, vi } from 'vitest';

import type { CategoryId, KnowledgeItemId, WorkspaceId } from '@knoverge/contracts';

import { DuplicateMatcher, type NearestMatch } from '../src/knowledge/duplicates.ts';
import { DomainError } from '../src/errors.ts';
import { SyncService, type SyncServiceOptions } from '../src/sync/service.ts';
import type { SyncCandidateRecord } from '../src/sync/repository.ts';

const workspaceId = 'ws_01M2XSEMANTICSEMANTIC001' as WorkspaceId;
const itemId = 'kn_01M2XSEMANTICSEMANTIC001' as KnowledgeItemId;

/** A knowledge repository that finds nothing by hash or by title. */
const emptyItems = {
  findByExternal: async () => null,
  findByContentHash: async () => [],
  findSimilarTitles: async () => [],
} as never;

const near = (similarity: number): NearestMatch[] => [
  {
    itemId,
    title: 'Ledger key rotation',
    markdownPath: 'knowledge/operations/ledger-key-rotation.md',
    similarity,
  },
];

const query = {
  workspaceId,
  title: 'Rotating the signing key',
  body: 'The chain is verified with the key of its time.',
  type: 'decision' as const,
  categoryIds: [] as readonly CategoryId[],
};

describe('the semantic step of the duplicate check', () => {
  it('is not taken when nothing can answer', async () => {
    // No provider configured is the default, and it has to stay a working
    // configuration (rule 9).
    const matcher = new DuplicateMatcher({ items: emptyItems, contentHash: () => 'sha256:x' });
    expect(await matcher.candidates(query)).toEqual([]);
  });

  it('offers a passage that means the same thing in other words', async () => {
    const nearest = vi.fn(async (_w: WorkspaceId, _t: string, _l: number) => near(0.93));
    const matcher = new DuplicateMatcher({
      items: emptyItems,
      contentHash: () => 'sha256:x',
      nearest,
    });

    const found = await matcher.candidates(query);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ reason: 'semantic', score: 0.93 });
    // The title and the body go in together: a passage means something
    // different under a different heading.
    expect(nearest.mock.calls[0]?.[1]).toContain(query.title);
    expect(nearest.mock.calls[0]?.[1]).toContain(query.body);
  });

  it('ignores a passage that is merely related', async () => {
    // A false positive refuses a write somebody meant to make, and the only
    // way past it is acknowledging a candidate that was never a duplicate.
    const matcher = new DuplicateMatcher({
      items: emptyItems,
      contentHash: () => 'sha256:x',
      nearest: async () => near(0.7),
    });
    expect(await matcher.candidates(query)).toEqual([]);
  });

  it('refuses the write when the match is visible to the proposer', async () => {
    const matcher = new DuplicateMatcher({
      items: emptyItems,
      contentHash: () => 'sha256:x',
      nearest: async () => near(0.95),
    });
    await expect(matcher.screen(query)).rejects.toBeInstanceOf(DomainError);
  });

  it('says nothing about a match the proposer may not read', async () => {
    // ADR 0017: naming it would tell an agent the title and the path of
    // knowledge it has no permission to read.
    const matcher = new DuplicateMatcher({
      items: emptyItems,
      contentHash: () => 'sha256:x',
      nearest: async () => near(0.95),
    });
    const hidden = await matcher.screen({ ...query, readable: async () => new Set<string>() });
    expect(hidden.map((c) => c.reason)).toEqual(['semantic']);
  });
});

describe('step E of reconciliation', () => {
  const session = {
    id: 'sync_01M2XSEMANTICSEMANTIC01',
    workspaceId,
    agentId: 'ag_01M2XSEMANTICSEMANTIC01' as never,
    sourceSystem: 'notion',
    sourceNamespace: null,
    state: 'open' as const,
    taxonomyVersion: 1,
    changeSequenceAtStart: 0,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 3_600_000),
    completedAt: null,
    stats: {},
  };

  const candidate = {
    id: 'cand_01M2XSEMANTICSEMANTIC1',
    syncSessionId: session.id,
    clientCandidateId: 'c1',
    externalKey: null,
    sourceContentHash: null,
    candidateContentHash: null,
    sourceModifiedAt: null,
    title: 'Rotating the signing key',
    knowledgeType: 'decision',
    language: 'en',
    proposedCategoryPaths: [],
    abstract: 'The chain is verified with the key of its time.',
    classification: 'pending' as const,
    classificationState: 'provisional' as const,
    matchReason: 'none' as const,
    matchedItemIds: [],
    serverReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  function serviceWith(nearest?: SyncServiceOptions['nearest']) {
    const written: SyncCandidateRecord[][] = [];
    let listed = false;
    const sync = {
      listCandidates: async () => {
        if (listed) return [];
        listed = true;
        return [candidate];
      },
      upsertCandidates: async (_tx: unknown, rows: SyncCandidateRecord[]) => {
        written.push(rows);
      },
    } as never;
    const service = new SyncService({
      uow: { run: async (fn: (tx: unknown) => unknown) => fn({}) } as never,
      sync,
      items: { findSimilarTitles: async () => [] } as never,
      categories: { list: async () => [] } as never,
      workspaces: { findById: async () => ({ archivedAt: null }) },
      ...(nearest ? { nearest } : {}),
    });
    return { service, written };
  }

  it('leaves a candidate new when nothing can answer', async () => {
    // The four steps before it work with no provider; a pass that cannot
    // reach step E stops at step D.
    const { service, written } = serviceWith();
    await service.refine(session, async (ids) => new Set(ids), { threshold: 0.6, limit: 5 });
    expect(written[0]?.[0]).toMatchObject({
      classification: 'new_candidate',
      matchReason: 'none',
    });
  });

  it('offers an item that means nearly the same thing', async () => {
    const { service, written } = serviceWith(async () => [{ itemId, similarity: 0.85 }]);
    await service.refine(session, async (ids) => new Set(ids), { threshold: 0.6, limit: 5 });
    expect(written[0]?.[0]).toMatchObject({
      classification: 'likely_match',
      matchReason: 'semantic',
      matchedItemIds: [itemId],
    });
  });

  it('says nothing about one the agent may not read', async () => {
    // Reconciliation must not become a way to enumerate restricted
    // categories: the candidate is classified as though nothing matched.
    const { service, written } = serviceWith(async () => [{ itemId, similarity: 0.95 }]);
    await service.refine(session, async () => new Set<string>(), { threshold: 0.6, limit: 5 });
    expect(written[0]?.[0]).toMatchObject({
      classification: 'new_candidate',
      matchedItemIds: [],
    });
  });

  it('ignores one that is merely related', async () => {
    const { service, written } = serviceWith(async () => [{ itemId, similarity: 0.5 }]);
    await service.refine(session, async (ids) => new Set(ids), { threshold: 0.6, limit: 5 });
    expect(written[0]?.[0]).toMatchObject({ classification: 'new_candidate' });
  });
});
