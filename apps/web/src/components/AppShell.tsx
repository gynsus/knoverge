import { useTranslation } from 'react-i18next';
import { Outlet } from 'react-router';

import { useAuth } from '../auth/use-auth.ts';
import { LanguageSwitcher } from './LanguageSwitcher.tsx';

export function AppShell() {
  const { t } = useTranslation();
  const auth = useAuth();
  const me = auth.state.kind === 'authenticated' ? auth.state.me : null;
  return (
    <div className="shell">
      <header className="topbar">
        <div>
          <h1>{t('app.name')}</h1>
          <p className="tagline">{t('app.tagline')}</p>
        </div>
        <nav aria-label={t('nav.label')}>
          <LanguageSwitcher />
          {me && (
            <>
              <span className="user">{me.user.display_name}</span>
              <button type="button" onClick={() => void auth.logout()}>
                {t('nav.logout')}
              </button>
            </>
          )}
        </nav>
      </header>
      <main>
        <Outlet />
      </main>
    </div>
  );
}
