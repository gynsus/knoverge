import { KnowledgeItemId, type Frontmatter } from '@knoverge/contracts';
import { describe, expect, it } from 'vitest';

import { MarkdownError, contentHash, parseItem, renderItem } from '../src/index.ts';

const ITEM = KnowledgeItemId.parse('kn_01J8Z3M4Q9V0X7K2B5N6P8R1T3');
// Crockford base32: no I, L, O or U.
const OTHER = KnowledgeItemId.parse('kn_01J8Z2A0C1D2E3F4G5H6J7K8M9');

const frontmatter = (over: Partial<Frontmatter> = {}): Frontmatter =>
  ({
    id: ITEM,
    title: 'Authentication strategy',
    type: 'decision',
    status: 'active',
    language: 'en',
    categories: ['projects/pixel-brisbane/architecture'],
    tags: ['auth'],
    review: 'human_reviewed',
    evidence: 'source_backed',
    disputed: false,
    valid_from: '2026-09-19T09:20:00Z',
    valid_until: null,
    observed_at: null,
    created_at: '2026-09-19T09:00:00Z',
    updated_at: '2026-09-19T09:20:00Z',
    sources: [],
    relations: [],
    ...over,
  }) as Frontmatter;

const BODY = 'Passwordless login uses a six-digit email code.\n\nGoogle OAuth is supported.\n';

describe('rendering an item', () => {
  it('writes the keys in the order the document fixes', () => {
    const text = renderItem({
      frontmatter: frontmatter({
        sources: [{ type: 'web_url', uri: 'https://example.com/spec', role: 'primary' }],
        relations: [{ type: 'supersedes', target: OTHER }],
      }),
      body: BODY,
    });
    const keys = text
      .split('\n---\n')[0]!
      .split('\n')
      .filter((line) => /^[a-z_]+:/.test(line))
      .map((line) => line.slice(0, line.indexOf(':')));
    expect(keys).toEqual([
      'id',
      'title',
      'type',
      'status',
      'language',
      'categories',
      'tags',
      'review',
      'evidence',
      'disputed',
      'valid_from',
      'valid_until',
      'observed_at',
      'created_at',
      'updated_at',
      'sources',
      'relations',
    ]);
  });

  it('is the same bytes however the fields arrived', () => {
    // A rendering that depended on key order in the input would show a diff
    // for a change that altered nothing.
    const shuffled = Object.fromEntries(
      Object.entries(frontmatter()).reverse(),
    ) as unknown as Frontmatter;
    expect(renderItem({ frontmatter: shuffled, body: BODY })).toBe(
      renderItem({ frontmatter: frontmatter(), body: BODY }),
    );
  });

  it('leaves empty lists out and keeps a stated null', () => {
    const text = renderItem({ frontmatter: frontmatter(), body: BODY });
    expect(text).not.toContain('sources:');
    expect(text).not.toContain('relations:');
    // Absent and null mean different things for a validity instant.
    expect(text).toContain('valid_until: null');
    expect(text).toContain('observed_at: null');
  });

  it('refuses frontmatter that is not valid', () => {
    expect(() => renderItem({ frontmatter: frontmatter({ title: '   ' }), body: BODY })).toThrow(
      MarkdownError,
    );
    expect(() =>
      renderItem({
        frontmatter: frontmatter({
          type: 'fact',
          summary_of: [`${ITEM}@rev_01J8Z3M4Q9V0X7K2B5N6P8R1T3`],
        }),
        body: BODY,
      }),
    ).toThrow(/summary/);
  });
});

describe('reading an item back', () => {
  it('round-trips', () => {
    const item = {
      frontmatter: frontmatter({
        sources: [
          {
            type: 'agent_session' as const,
            client: 'claude-code',
            session_id: 'sess-42',
            role: 'supporting' as const,
          },
        ],
        relations: [{ type: 'supersedes' as const, target: OTHER }],
        external: { source_system: 'claude-code', external_key: 'repo:architecture/auth' },
      }),
      body: BODY,
    };
    const text = renderItem(item);
    const back = parseItem(text);
    expect(back.frontmatter).toEqual(item.frontmatter);
    expect(back.body).toBe(BODY);
    // And rendering what was read produces the same file again.
    expect(renderItem(back)).toBe(text);
  });

  it('rejects a key it does not know', () => {
    // Dropping it would silently discard what a later version meant by it, and
    // this file is the canonical copy rather than a cache of one.
    const text = renderItem({ frontmatter: frontmatter(), body: BODY }).replace(
      'title:',
      'confidence: 0.9\ntitle:',
    );
    expect(() => parseItem(text)).toThrow(/confidence/);
  });

  it('rejects a file with no frontmatter, and one that never closes it', () => {
    expect(() => parseItem('Just some text.\n')).toThrow(/does not start/);
    expect(() => parseItem('---\nid: kn_x\n')).toThrow(/never closed/);
  });

  it('reads a file written on Windows, and one with a byte order mark', () => {
    const text = renderItem({ frontmatter: frontmatter(), body: BODY });
    const windows = `\uFEFF${text.replace(/\n/g, '\r\n')}`;
    expect(parseItem(windows).body).toBe(BODY);
  });

  it('normalises the body it returns, so the hash does not move', () => {
    const text = renderItem({ frontmatter: frontmatter(), body: 'One.   \n\n\n\n\nTwo.' });
    const back = parseItem(text);
    expect(back.body).toBe('One.\n\nTwo.\n');
    expect(contentHash(back.frontmatter.title, back.body)).toBe(
      contentHash('Authentication strategy', 'One.\n\nTwo.\n'),
    );
  });

  it('gives the same content hash when only metadata changed', () => {
    // Frontmatter is excluded from the content hash on purpose: recategorising
    // or reviewing an item does not change what it says.
    const one = parseItem(renderItem({ frontmatter: frontmatter(), body: BODY }));
    const two = parseItem(
      renderItem({
        frontmatter: frontmatter({ review: 'unreviewed', tags: ['auth', 'security'] }),
        body: BODY,
      }),
    );
    expect(contentHash(one.frontmatter.title, one.body)).toBe(
      contentHash(two.frontmatter.title, two.body),
    );
  });
});
