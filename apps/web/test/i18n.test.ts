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

describe('message catalogues', () => {
  it('every supported locale has exactly the English keys', () => {
    const enKeys = flatten(resources.en.common).sort();
    for (const locale of SUPPORTED_LOCALES) {
      expect(flatten(resources[locale].common).sort()).toEqual(enKeys);
    }
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
