import type { PermissionAction } from '@knoverge/contracts';
import {
  BookOpenText,
  Bot,
  FolderTree,
  LayoutDashboard,
  Settings,
  ShieldCheck,
} from 'lucide-react';
import type { ComponentType } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, Outlet, useLocation } from 'react-router';

import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from '@/components/ui/sidebar';
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
  { to: '/', key: 'home', icon: LayoutDashboard },
  { to: '/taxonomy', key: 'taxonomy', icon: FolderTree, needs: 'taxonomy.read' },
  { to: '/agents', key: 'agents', icon: Bot, needs: 'agent.manage' },
  { to: '/policy', key: 'policy', icon: ShieldCheck, needs: 'policy.manage' },
  { to: '/workspace', key: 'workspace', icon: BookOpenText },
  { to: '/settings', key: 'settings', icon: Settings },
] as const satisfies readonly {
  to: string;
  key: string;
  icon: ComponentType<{ className?: string }>;
  needs?: PermissionAction;
}[];

export function AppShell() {
  const { t } = useTranslation();
  const auth = useAuth();
  const workspaces = useWorkspaceContext();
  const location = useLocation();
  const me = auth.state.kind === 'authenticated' ? auth.state.me : null;
  const visible = NAV.filter((item) => !('needs' in item) || workspaces.can(item.needs));

  // Anonymous pages are one card in the middle of the screen. A navigation
  // rail with nothing in it would only take space away from them.
  if (!me) {
    return (
      <div className="mx-auto flex min-h-screen w-full max-w-5xl flex-col px-4 py-4 sm:px-6">
        <header className="flex flex-wrap items-start justify-between gap-3 pb-6">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">{t('app.name')}</h1>
            <p className="text-sm text-muted-foreground">{t('app.tagline')}</p>
          </div>
          <LanguageSwitcher />
        </header>
        <main id="main" tabIndex={-1} className="grid gap-4">
          <Outlet />
        </main>
      </div>
    );
  }

  return (
    <SidebarProvider>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:border focus:border-input focus:bg-card focus:px-3 focus:py-2"
      >
        {t('nav.skip_to_content')}
      </a>
      <Sidebar collapsible="icon">
        <SidebarHeader className="gap-2 px-3 py-3">
          <div className="group-data-[collapsible=icon]:hidden">
            <p className="text-sm font-semibold leading-tight">{t('app.name')}</p>
            <p className="text-xs text-muted-foreground">{t('app.tagline')}</p>
          </div>
          {workspaces.available.length > 1 && (
            <Select
              value={workspaces.selectedId ?? ''}
              onChange={(e) => workspaces.select(e.target.value)}
              aria-label={t('nav.workspace_label')}
              className="h-8 text-sm group-data-[collapsible=icon]:hidden"
            >
              {workspaces.available.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          )}
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {visible.map((item) => {
                  const Icon = item.icon;
                  const active =
                    item.to === '/'
                      ? location.pathname === '/'
                      : location.pathname.startsWith(item.to);
                  return (
                    <SidebarMenuItem key={item.to}>
                      {/* The label stays in the markup when the rail is
                          collapsed, so the accessible name survives. The
                          tooltip is for a pointer, and a touch screen has
                          none. */}
                      <SidebarMenuButton asChild isActive={active} tooltip={t(`nav.${item.key}`)}>
                        <NavLink to={item.to} end={item.to === '/'}>
                          <Icon className="size-4" />
                          <span>{t(`nav.${item.key}`)}</span>
                        </NavLink>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter className="gap-2 px-3 py-3 group-data-[collapsible=icon]:hidden">
          <span className="truncate text-sm text-muted-foreground">{me.user.display_name}</span>
          <Button variant="outline" size="sm" onClick={() => void auth.logout()}>
            {t('nav.logout')}
          </Button>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>
      <SidebarInset>
        <header className="flex items-center gap-2 border-b border-border px-4 py-2">
          <SidebarTrigger aria-label={t('nav.toggle_sidebar')} />
          <div className="ml-auto flex items-center gap-2">
            <LanguageSwitcher />
          </div>
        </header>
        <div id="main" tabIndex={-1} className="grid gap-4 p-4 sm:p-6">
          <Outlet />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
