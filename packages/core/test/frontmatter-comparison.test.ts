import type { Frontmatter } from '@knoverge/contracts';
import { describe, expect, it } from 'vitest';

import { compareFrontmatter } from '../src/index.ts';

/** The fields every frontmatter carries, so a test can vary one of them. */
const base = (over: Partial<Frontmatter> = {}): Frontmatter =>
  ({
    id: 'kn_01J8Z3M4Q9V0X7K2B5N6P8R1T3',
    title: 'Authentication strategy',
    type: 'decision',
    status: 'active',
    language: 'en',
    categories: ['architecture'],
    tags: ['auth'],
    review: 'human_reviewed',
    evidence: 'source_backed',
    disputed: false,
    valid_from: null,
    valid_until: null,
    created_at: '2026-09-19T09:00:00.000Z',
    updated_at: '2026-09-19T09:20:00.000Z',
    sources: [],
    relations: [],
    ...over,
  }) as Frontmatter;

describe('comparing two frontmatters', () => {
  it('is not fooled by the order the keys happen to be in', () => {
    // The order a source object's keys are written in is not part of what it
    // says. One side of this comparison is often a row read back out of jsonb
    // and the other the same file parsed from YAML, and jsonb does not keep the
    // order a value was written in: the integrity checker's first run against a
    // real workspace reported seventy-three items as disagreeing about sources
    // whose sources were identical.
    const stored = base({
      sources: [{ uri: 'https://example.com/a', role: 'primary', type: 'file' }],
      external: { external_key: 'docs/a.md', source_system: 'claude-code' },
    } as Partial<Frontmatter>);
    const parsed = base({
      sources: [{ type: 'file', uri: 'https://example.com/a', role: 'primary' }],
      external: { source_system: 'claude-code', external_key: 'docs/a.md' },
    } as Partial<Frontmatter>);

    expect(compareFrontmatter(stored, parsed)).toEqual([]);
  });

  it('still reports a field that says something else', () => {
    const changed = compareFrontmatter(
      base({ sources: [{ type: 'file', uri: 'https://example.com/a', role: 'primary' }] }),
      base({ sources: [{ type: 'file', uri: 'https://example.com/b', role: 'primary' }] }),
    );
    expect(changed.map((c) => c.field)).toEqual(['sources']);
  });

  it('reports a reordered list, because order is what a list says', () => {
    // Not the same as key order: the first source is the primary one, and two
    // lists in different orders are two different claims about provenance.
    const changed = compareFrontmatter(
      base({ tags: ['auth', 'login'] }),
      base({ tags: ['login', 'auth'] }),
    );
    expect(changed.map((c) => c.field)).toEqual(['tags']);
  });

  it('says nothing about a timestamp that changes on every revision', () => {
    expect(compareFrontmatter(base(), base({ updated_at: '2026-10-01T00:00:00.000Z' }))).toEqual(
      [],
    );
  });
});
