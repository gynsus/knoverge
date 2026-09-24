import { describe, expect, it } from 'vitest';

import { RRF_K, bestPerItem, fuse } from '../src/index.ts';

describe('fusing two rankings', () => {
  it('rewards a result both lists found', () => {
    // b is second in each list and beats a, which only one list saw at all.
    const fused = fuse(['a', 'b'], ['c', 'b']);
    expect(fused[0]?.id).toBe('b');
    expect(fused[0]?.lexicalRank).toBe(2);
    expect(fused[0]?.semanticRank).toBe(2);
  });

  it('keeps a result only one list found', () => {
    // The point of the second opinion: a passage that means the right thing
    // without containing the words still has to surface.
    const fused = fuse(['a'], ['z']);
    expect(fused.map((f) => f.id).sort()).toEqual(['a', 'z']);
    expect(fused.find((f) => f.id === 'z')?.lexicalRank).toBeNull();
  });

  it('scores by position rather than by the scores the lists carried', () => {
    // ts_rank_cd has no ceiling and moves with the corpus; cosine similarity
    // is bounded and moves with the model. Position is the only thing the two
    // lists agree about.
    const fused = fuse(['a'], ['a']);
    expect(fused[0]?.score).toBeCloseTo(2 / (RRF_K + 1), 10);
  });

  it('answers the same way for the same input, whatever the order of ties', () => {
    const first = fuse(['a', 'b'], ['b', 'a']);
    const second = fuse(['a', 'b'], ['b', 'a']);
    expect(first).toEqual(second);
  });

  it('has nothing to fuse when neither list found anything', () => {
    expect(fuse([], [])).toEqual([]);
  });
});

describe('folding chunks to items', () => {
  it('keeps the first chunk of each item and drops the rest', () => {
    const ordered = [
      { chunk: 'c1', item: 'i1' },
      { chunk: 'c2', item: 'i1' },
      { chunk: 'c3', item: 'i2' },
    ];
    expect(bestPerItem(ordered, (c) => c.item).map((c) => c.chunk)).toEqual(['c1', 'c3']);
  });
});
