import { useTranslation } from 'react-i18next';
import { NavLink, Outlet } from 'react-router';

import { useAuth } from '../auth/use-auth.ts';
import { LanguageSwitcher } from './LanguageSwitcher.tsx';

const NAV = [
  { to: '/', key: 'home' },
  { to: '/taxonomy', key: 'taxonomy' },
  { to: '/agents', key: 'agents' },
  { to: '/policy', key: 'policy' },
  { to: '/settings', key: 'settings' },
] as const;

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
        <div className="account">
          <LanguageSwitcher />
          {me && (
            <>
              <span className="user">{me.user.display_name}</span>
              <button type="button" onClick={() => void auth.logout()}>
                {t('nav.logout')}
              </button>
            </>
          )}
        </div>
      </header>
      {me && (
        <nav aria-label={t('nav.label')} className="mainnav">
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.to === '/'}>
              {t(`nav.${item.key}`)}
            </NavLink>
          ))}
        </nav>
      )}
      <main>
        <Outlet />
      </main>
    </div>
  );
}
