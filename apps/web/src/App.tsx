import { useTranslation } from 'react-i18next';
import { Route, Routes } from 'react-router';

import { LanguageSwitcher } from './components/LanguageSwitcher.tsx';
import { StatusPage } from './pages/StatusPage.tsx';

export function App() {
  const { t } = useTranslation();
  return (
    <main>
      <header>
        <h1>{t('app.name')}</h1>
        <p>{t('app.tagline')}</p>
        <LanguageSwitcher />
      </header>
      <Routes>
        <Route path="/" element={<StatusPage />} />
      </Routes>
    </main>
  );
}
