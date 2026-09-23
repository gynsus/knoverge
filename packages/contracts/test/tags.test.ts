import { describe, expect, it } from 'vitest';

import { Tag, canonicalTag, normaliseTag } from '../src/index.ts';

/**
 * A tag is content, not an identifier (ADR 0019).
 *
 * It was a slug, which meant a Russian item could not carry Russian tags in a
 * product whose knowledge is explicitly in any language.
 */
describe('a tag', () => {
  it('accepts any script, and words with spaces in them', () => {
    for (const tag of [
      'git',
      'машинное обучение',
      '機械学習',
      'Domain-Driven Design',
      'ADR 0019',
    ]) {
      expect(Tag.safeParse(tag).success, tag).toBe(true);
    }
  });

  it('is validated, never transformed', () => {
    // The response schemas are also what responses are serialised with, and a
    // Zod transform only runs one way: normalising inside the schema made
    // every response carrying a tag fail to encode. Canonicalising is the
    // domain's job.
    expect(Tag.parse('  machine   learning ')).toBe('  machine   learning ');
    expect(canonicalTag('  machine   learning ')).toBe('machine learning');
  });

  it('refuses what no interface could show or separate', () => {
    // A control character is invisible wherever the tag is displayed.
    expect(Tag.safeParse('git\u0007').success).toBe(false);
    // Frontmatter, the query string and the tag input all separate on commas.
    expect(Tag.safeParse('git,portability').success).toBe(false);
    expect(Tag.safeParse('   ').success).toBe(false);
    expect(Tag.safeParse('x'.repeat(65)).success).toBe(false);
  });
});

describe('two tags are the same tag when', () => {
  it('they differ only in case or in spacing', () => {
    expect(normaliseTag('Machine  Learning')).toBe(normaliseTag('machine learning'));
    expect(normaliseTag(' GIT ')).toBe('git');
  });

  it('they differ only in how they are composed', () => {
    // "й" as one code point, and as "и" plus a combining breve. Identical on
    // screen, unequal as strings: without NFC a workspace grows two tags
    // nobody can tell apart.
    const precomposed = 'кйев';
    const decomposed = 'кйев';
    expect(precomposed).not.toBe(decomposed);
    expect(normaliseTag(precomposed)).toBe(normaliseTag(decomposed));
  });
});
