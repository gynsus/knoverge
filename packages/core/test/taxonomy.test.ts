import { describe, expect, it } from 'vitest';

import { slugify } from '../src/index.ts';

describe('slugify', () => {
  it('handles plain Latin names', () => {
    expect(slugify('Pixel Brisbane')).toBe('pixel-brisbane');
    expect(slugify('  Spaces   everywhere  ')).toBe('spaces-everywhere');
  });

  it('strips diacritics instead of turning them into separators', () => {
    expect(slugify('Über Café!')).toBe('uber-cafe');
    expect(slugify('Ångström')).toBe('angstrom');
  });

  it('transliterates Cyrillic so Russian names get readable identifiers', () => {
    expect(slugify('Архитектура')).toBe('arhitektura');
    expect(slugify('Поиск работы')).toBe('poisk-raboty');
    expect(slugify('Ёлка')).toBe('elka');
    expect(slugify('Объявления')).toBe('obyavleniya');
  });

  it('returns an empty string when nothing transliterable remains', () => {
    expect(slugify('日本語')).toBe('');
    expect(slugify('!!!')).toBe('');
  });

  it('never ends with a separator after truncation', () => {
    const long = slugify('A'.repeat(100));
    expect(long).toHaveLength(64);
    expect(long.endsWith('-')).toBe(false);
    expect(slugify(`${'a'.repeat(63)} word`)).not.toMatch(/-$/);
  });
});
