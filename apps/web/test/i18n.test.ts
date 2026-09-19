import { describe, expect, it } from 'vitest';

import { SUPPORTED_LOCALES, createI18n, resources } from '../src/i18n.ts';

function flatten(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return value && typeof value === 'object'
      ? flatten(value as Record<string, unknown>, path)
      : [path];
  });
}

/**
 * Strips the plural category i18next appends to a key. English has one and
 * other; Russian has one, few, many and other. Comparing raw keys would call
 * every correct Russian plural a mismatch.
 */
function bases(keys: string[]): string[] {
  return [...new Set(keys.map((k) => k.replace(/_(zero|one|two|few|many|other)$/, '')))].sort();
}

describe('message catalogues', () => {
  it('every supported locale has exactly the English keys', () => {
    const enKeys = bases(flatten(resources.en.common));
    for (const locale of SUPPORTED_LOCALES) {
      expect(bases(flatten(resources[locale].common))).toEqual(enKeys);
    }
  });

  it('resolves Russian plural categories, which English does not have', async () => {
    const i18n = createI18n('ru');
    await i18n.loadLanguages(['ru']);
    i18n.addResourceBundle('ru', 'common', {
      items_one: '{{count}} элемент',
      items_few: '{{count}} элемента',
      items_many: '{{count}} элементов',
      items_other: '{{count}} элемента',
    });
    expect(i18n.t('items', { count: 1 })).toBe('1 элемент');
    expect(i18n.t('items', { count: 3 })).toBe('3 элемента');
    expect(i18n.t('items', { count: 7 })).toBe('7 элементов');
  });

  it('translates in the requested locale and falls back to English', async () => {
    const i18n = createI18n('ru');
    await i18n.loadLanguages(['ru']);
    expect(i18n.t('status.title')).toBe('Состояние сервера');
    expect(i18n.t('status.latency', { count: 5 })).toBe('5 мс');
    await i18n.changeLanguage('en');
    expect(i18n.t('status.title')).toBe('Server status');
  });
});

describe('the document language', () => {
  it('is set on the first render, not only when the reader switches', async () => {
    document.documentElement.lang = 'en';
    const i18n = createI18n('ru');
    await i18n.loadLanguages(['ru']);
    // init() emits languageChanged before a handler can be attached, so a page
    // of Russian text used to stay declared as English.
    expect(document.documentElement.lang).toBe('ru');
    await i18n.changeLanguage('en');
    expect(document.documentElement.lang).toBe('en');
  });
});
