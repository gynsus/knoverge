import { useTranslation } from 'react-i18next';

import { SUPPORTED_LOCALES, type Locale } from '../i18n.ts';

export function LanguageSwitcher() {
  const { t, i18n } = useTranslation();
  const current = (i18n.resolvedLanguage ?? 'en') as Locale;
  return (
    <label>
      {t('language.label')}{' '}
      <select
        value={current}
        onChange={(event) => void i18n.changeLanguage(event.target.value)}
        aria-label={t('language.label')}
      >
        {SUPPORTED_LOCALES.map((locale) => (
          <option key={locale} value={locale}>
            {t(`language.${locale}`)}
          </option>
        ))}
      </select>
    </label>
  );
}
