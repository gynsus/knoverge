import { describe, expect, it } from 'vitest';

import {
  applyVerdict,
  disputes,
  sameVerdict,
  verdict,
  windowsOverlap,
} from '../src/knowledge/disputes.ts';
import type { DisputeSide } from '../src/knowledge/disputes.ts';
import type { Frontmatter, KnowledgeItemId } from '@knoverge/contracts';

const A = 'kn_01M3AAAAAAAAAAAAAAAAAAAAAA' as KnowledgeItemId;
const B = 'kn_01M3BBBBBBBBBBBBBBBBBBBBBB' as KnowledgeItemId;
const C = 'kn_01M3CCCCCCCCCCCCCCCCCCCCCC' as KnowledgeItemId;

function side(itemId: KnowledgeItemId, over: Partial<DisputeSide> = {}): DisputeSide {
  return { itemId, status: 'active', window: { from: null, until: null }, ...over };
}

describe('validity windows', () => {
  it('treats a claim with no dates as one that always held', () => {
    expect(
      windowsOverlap({ from: null, until: null }, { from: '2026-01-01T00:00:00Z', until: null }),
    ).toBe(true);
  });

  it('does not overlap a period that ended where the other began', () => {
    // How a supersession sets the pair: the old claim stops at the instant the
    // new one starts, so treating the end as exclusive is what keeps a
    // succession from reading as a disagreement.
    expect(
      windowsOverlap(
        { from: '2026-01-01T00:00:00Z', until: '2026-06-01T00:00:00Z' },
        { from: '2026-06-01T00:00:00Z', until: null },
      ),
    ).toBe(false);
  });

  it('overlaps periods that shared an instant', () => {
    expect(
      windowsOverlap(
        { from: '2026-01-01T00:00:00Z', until: '2026-06-02T00:00:00Z' },
        { from: '2026-06-01T00:00:00Z', until: null },
      ),
    ).toBe(true);
  });
});

describe('whether a contradiction is live', () => {
  it('holds between two active items that were true at once', () => {
    expect(disputes(side(A), side(B))).toBe(true);
  });

  it('ends when the other side is superseded', () => {
    expect(disputes(side(A), side(B, { status: 'superseded' }))).toBe(false);
  });

  it('ends when the other side is deleted', () => {
    expect(disputes(side(A), side(B, { status: 'deleted' }))).toBe(false);
  });

  it('does not survive the item that holds it leaving the active set', () => {
    // A deleted item disputes nothing: it is out of the answer either way, so
    // a badge on it would be a claim about knowledge nobody is being given.
    expect(disputes(side(A, { status: 'deleted' }), side(B))).toBe(false);
  });

  it('never counts an item as disputing itself', () => {
    // The relations list cannot hold it, because an item may not relate to
    // itself. The verdict is also fed the write's own new state, though, so a
    // substitution that lands on the item being written must not mark it.
    expect(disputes(side(A), side(A))).toBe(false);
  });

  it('is not a dispute when the two claims held in different periods', () => {
    expect(
      disputes(
        side(A, { window: { from: null, until: '2026-06-01T00:00:00Z' } }),
        side(B, { window: { from: '2026-06-01T00:00:00Z', until: null } }),
      ),
    ).toBe(false);
  });
});

describe('the verdict for one item', () => {
  it('is disputed by the item it reported a contradiction against', () => {
    // The reporter is disputed too. Reporting a disagreement is not a way to
    // put somebody else's claim in doubt while keeping your own clean.
    expect(verdict(side(A), [side(B)], [])).toEqual({ disputed: true, disputedBy: [] });
  });

  it('names who disputes it when the relation came from the other end', () => {
    expect(verdict(side(A), [], [side(B)])).toEqual({ disputed: true, disputedBy: [B] });
  });

  it('lists incoming disputers sorted, so two runs render the same bytes', () => {
    expect(verdict(side(A), [], [side(C), side(B)]).disputedBy).toEqual([B, C]);
  });

  it('leaves out an incoming relation from an item that is no longer active', () => {
    expect(verdict(side(A), [], [side(B, { status: 'superseded' })])).toEqual({
      disputed: false,
      disputedBy: [],
    });
  });

  it('is not disputed with no contradictions at all', () => {
    expect(verdict(side(A), [], [])).toEqual({ disputed: false, disputedBy: [] });
  });
});

describe('putting a verdict in a frontmatter', () => {
  const base = {
    id: A,
    title: 'A claim',
    type: 'fact',
    status: 'active',
    language: 'en',
    categories: [],
    tags: [],
    review: 'unreviewed',
    evidence: 'none',
    disputed: false,
    valid_from: null,
    valid_until: null,
    observed_at: null,
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    sources: [],
    relations: [],
  } as Frontmatter;
  const at = new Date('2026-09-26T10:00:00.000Z');

  it('names who disputes it and says when that was decided', () => {
    const next = applyVerdict(base, { disputed: true, disputedBy: [B] }, at);
    expect(next.disputed).toBe(true);
    expect(next.disputed_by).toEqual([B]);
    expect(next.updated_at).toBe('2026-09-26T10:00:00.000Z');
  });

  it('leaves out the list rather than writing an empty one', () => {
    // The shape a file round trip produces: the renderer drops empty lists, so
    // a stored copy that kept one would differ from the canonical copy it
    // describes and show as a change in a diff that changed nothing.
    const marked = applyVerdict(base, { disputed: true, disputedBy: [B] }, at);
    const cleared = applyVerdict(marked, { disputed: false, disputedBy: [] }, at);
    expect('disputed_by' in cleared).toBe(false);
  });

  it('sees no change when the frontmatter already says it', () => {
    const marked = applyVerdict(base, { disputed: true, disputedBy: [B] }, at);
    expect(sameVerdict(marked, { disputed: true, disputedBy: [B] })).toBe(true);
    // An absent list and an empty one are the same statement.
    expect(sameVerdict(base, { disputed: false, disputedBy: [] })).toBe(true);
    expect(sameVerdict(marked, { disputed: true, disputedBy: [C] })).toBe(false);
    expect(sameVerdict(marked, { disputed: false, disputedBy: [] })).toBe(false);
    // The flag alone can move: an item disputed by its own outgoing relation
    // has nobody in the list, so comparing only the list would miss it.
    expect(sameVerdict(base, { disputed: true, disputedBy: [] })).toBe(false);
  });
});
