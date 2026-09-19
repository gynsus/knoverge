import i18next from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';

import en from './locales/en/common.json';
import ru from './locales/ru/common.json';

export const SUPPORTED_LOCALES = ['en', 'ru'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const resources = {
  en: { common: en },
  ru: { common: ru },
} as const;

export function createI18n(initialLocale?: Locale) {
  const instance = i18next.createInstance();
  void instance
    .use(LanguageDetector)
    .use(initReactI18next)
    .init({
      resources,
      ...(initialLocale ? { lng: initialLocale } : {}),
      fallbackLng: 'en',
      supportedLngs: SUPPORTED_LOCALES,
      defaultNS: 'common',
      ns: ['common'],
      interpolation: { escapeValue: false },
      detection: {
        order: ['localStorage', 'navigator'],
        caches: ['localStorage'],
        lookupLocalStorage: 'knoverge.locale',
      },
    });
  if (typeof document !== 'undefined') {
    instance.on('languageChanged', (lng) => {
      document.documentElement.lang = lng;
    });
  }
  return instance;
}
