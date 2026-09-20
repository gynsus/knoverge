import type { PermissionAction } from '@knoverge/contracts';
import { useTranslation } from 'react-i18next';
import { NavLink, Outlet } from 'react-router';

import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';
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
    <div className="mx-auto w-full max-w-5xl px-4 py-4 sm:px-6">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-10 focus:rounded-md focus:border focus:border-input focus:bg-card focus:px-3 focus:py-2"
      >
        {t('nav.skip_to_content')}
      </a>
      <header className="flex flex-wrap items-start justify-between gap-3 pb-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{t('app.name')}</h1>
          <p className="text-sm text-muted-foreground">{t('app.tagline')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {me && workspaces.available.length > 1 && (
            <Select
              value={workspaces.selectedId ?? ''}
              onChange={(e) => workspaces.select(e.target.value)}
              aria-label={t('nav.workspace_label')}
              className="h-8 w-auto text-sm"
            >
              {workspaces.available.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          )}
          <LanguageSwitcher />
          {me && (
            <>
              <span className="text-sm text-muted-foreground">{me.user.display_name}</span>
              <Button variant="outline" size="sm" onClick={() => void auth.logout()}>
                {t('nav.logout')}
              </Button>
            </>
          )}
        </div>
      </header>
      {me && (
        <nav
          aria-label={t('nav.label')}
          // Scrolls sideways on a phone rather than wrapping into three rows.
          className="mb-4 flex gap-1 overflow-x-auto border-b border-border pb-px"
        >
          {visible.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                cn(
                  'shrink-0 border-b-2 border-transparent px-3 py-2 text-sm whitespace-nowrap',
                  isActive
                    ? 'border-primary font-semibold text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )
              }
            >
              {t(`nav.${item.key}`)}
            </NavLink>
          ))}
        </nav>
      )}
      <main id="main" tabIndex={-1} className="grid gap-4">
        <Outlet />
      </main>
    </div>
  );
}
