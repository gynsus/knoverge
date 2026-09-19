import type { PermissionAction } from '@knoverge/contracts';
import { useTranslation } from 'react-i18next';
import { NavLink, Outlet } from 'react-router';

import { useAuth } from '../auth/use-auth.ts';
import { useWorkspaceContext } from '../auth/use-workspace.ts';
import { LanguageSwitcher } from './LanguageSwitcher.tsx';

/**
 * Each section names the permission that makes it useful. A section whose
 * every request the server refuses is not shown: offering it made "This action
 * is not allowed." the normal state of half the application, and each refused
 * submission wrote a refusal into the ledger.
 */
const NAV = [
  { to: '/', key: 'home' },
  { to: '/taxonomy', key: 'taxonomy', needs: 'taxonomy.read' },
  { to: '/agents', key: 'agents', needs: 'agent.manage' },
  { to: '/policy', key: 'policy', needs: 'policy.manage' },
  { to: '/workspace', key: 'workspace' },
  { to: '/settings', key: 'settings' },
] as const satisfies readonly { to: string; key: string; needs?: PermissionAction }[];

export function AppShell() {
  const { t } = useTranslation();
  const auth = useAuth();
  const workspaces = useWorkspaceContext();
  const me = auth.state.kind === 'authenticated' ? auth.state.me : null;
  const visible = NAV.filter((item) => !('needs' in item) || workspaces.can(item.needs));
  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        {t('nav.skip_to_content')}
      </a>
      <header className="topbar">
        <div>
          <h1>{t('app.name')}</h1>
          <p className="tagline">{t('app.tagline')}</p>
        </div>
        <div className="account">
          {me && workspaces.available.length > 1 && (
            <label className="workspace-picker">
              {t('nav.workspace_label')}
              <select
                value={workspaces.selectedId ?? ''}
                onChange={(e) => workspaces.select(e.target.value)}
              >
                {workspaces.available.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
          )}
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
          {visible.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.to === '/'}>
              {t(`nav.${item.key}`)}
            </NavLink>
          ))}
        </nav>
      )}
      <main id="main" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
