import type { ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';

import { Select } from '@/components/ui/select';
import { SUPPORTED_LOCALES, type Locale } from '../i18n.ts';

/**
 * Takes select props and passes them on, because `Field` labels its child by
 * giving it an id. A component that swallowed them would leave the visible
 * label pointing at nothing.
 */
export function LanguageSwitcher(props: ComponentProps<'select'>) {
  const { t, i18n } = useTranslation();
  const current = (i18n.resolvedLanguage ?? 'en') as Locale;
  return (
    <Select
      value={current}
      onChange={(event) => void i18n.changeLanguage(event.target.value)}
      aria-label={t('language.label')}
      className="h-8 w-auto text-sm"
      {...props}
    >
      {SUPPORTED_LOCALES.map((locale) => (
        <option key={locale} value={locale}>
          {t(`language.${locale}`)}
        </option>
      ))}
    </Select>
  );
}
