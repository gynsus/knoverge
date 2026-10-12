import { GardeningNoticeSubject, GardeningRuleName } from '@knoverge/contracts';
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

  it('names every gardening rule the server can report', () => {
    // The screen builds these keys from the rule name the server sends, so a
    // rule added without a catalogue entry shows the key itself and no literal
    // `t('...')` guard can catch it. The rules are also the one place the
    // screen lists something that found nothing, so a missing name would be
    // the only thing a reader saw about it.
    const rules = resources.en.common.gardening.rule as Record<
      string,
      { title: string; description: string }
    >;
    expect(Object.keys(rules).sort()).toEqual([...GardeningRuleName.options].sort());
    for (const name of GardeningRuleName.options) {
      expect(rules[name]?.title, name).toBeTruthy();
      expect(rules[name]?.description, name).toBeTruthy();
    }

    // The same hazard one level down: a notice says what kind of thing it is
    // about, and the screen builds that key from what the server sent.
    const subjects = resources.en.common.gardening.subject as Record<string, string>;
    expect(Object.keys(subjects).sort()).toEqual([...GardeningNoticeSubject.options].sort());
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

  it('agrees with the number in both languages, where a sentence counts two things', async () => {
    // i18next pluralises one `count` per key, and these sentences count two or three
    // things at once. So each countable noun is its own key and the sentence takes
    // the rendered phrase — which is the only way Russian's four forms and English's
    // two both end up on the noun rather than on the sentence.
    const en = createI18n('en');
    await en.loadLanguages(['en']);
    const phrase = (i18n: typeof en, noun: string, count: number) =>
      i18n.t(`taxonomy.n_${noun}`, { count });
    expect(phrase(en, 'items', 1)).toBe('1 knowledge item');
    expect(phrase(en, 'items', 7)).toBe('7 knowledge items');
    expect(
      en.t('taxonomy.delete_blocked', {
        items: phrase(en, 'items', 1),
        categories: phrase(en, 'categories', 1),
      }),
    ).toBe('Holds 1 knowledge item and 1 category under it.');

    const ru = createI18n('ru');
    await ru.loadLanguages(['ru']);
    // One, few, many: the three Russian needs and English does not have.
    expect(phrase(ru, 'items', 1)).toBe('1 запись');
    expect(phrase(ru, 'items', 3)).toBe('3 записи');
    expect(phrase(ru, 'items', 12)).toBe('12 записей');
    expect(
      ru.t('taxonomy.delete_blocked', {
        items: phrase(ru, 'items', 1),
        categories: phrase(ru, 'categories', 1),
      }),
    ).toBe('Здесь 1 запись и 1 раздел внутри.');
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
