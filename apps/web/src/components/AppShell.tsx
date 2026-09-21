import type { PermissionAction } from '@knoverge/contracts';
import {
  BookOpenText,
  Bot,
  Building2,
  FolderTree,
  Inbox,
  LayoutDashboard,
  LogOut,
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
  useSidebar,
} from '@/components/ui/sidebar';
import { useAuth } from '../auth/use-auth.ts';
import { useWorkspaceContext } from '../auth/use-workspace.ts';
import { ErrorNotice } from './ErrorNotice.tsx';
import { LanguageSwitcher } from './LanguageSwitcher.tsx';

/**
 * Each section names the permission that makes it useful. A section whose
 * every request the server refuses is not shown: offering it made "This action
 * is not allowed." the normal state of half the application, and each refused
 * submission wrote a refusal into the ledger.
 */
const NAV = [
  { to: '/', key: 'home', icon: LayoutDashboard },
  { to: '/knowledge', key: 'knowledge', icon: BookOpenText, needs: 'knowledge.read' },
  { to: '/review', key: 'review', icon: Inbox, needs: 'knowledge.approve' },
  { to: '/taxonomy', key: 'taxonomy', icon: FolderTree, needs: 'taxonomy.read' },
  { to: '/agents', key: 'agents', icon: Bot, needs: 'agent.manage' },
  { to: '/policy', key: 'policy', icon: ShieldCheck, needs: 'policy.manage' },
  { to: '/workspace', key: 'workspace', icon: Building2 },
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
  const me = auth.state.kind === 'authenticated' ? auth.state.me : null;

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
          {/* Kept here and nowhere else in the chrome: somebody choosing a
              language before they have an account has no settings page to go
              to, and the first thing a new operator sees is this screen. */}
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
      <SignedInShell displayName={me.user.display_name} onLogout={() => void auth.logout()} />
    </SidebarProvider>
  );
}

/**
 * Inside the provider, so it can close the drawer.
 *
 * Below the mobile breakpoint the rail is a modal dialog. Choosing a section
 * navigates behind it and leaves it open, with its focus trap and its overlay,
 * so every single navigation on a phone needs a second gesture to dismiss it.
 */
function SignedInShell({ displayName, onLogout }: { displayName: string; onLogout: () => void }) {
  const { t } = useTranslation();
  const workspaces = useWorkspaceContext();
  const location = useLocation();
  const { setOpenMobile } = useSidebar();
  const visible = NAV.filter((item) => !('needs' in item) || workspaces.can(item.needs));
  const current = visible.find((item) =>
    item.to === '/' ? location.pathname === '/' : location.pathname.startsWith(item.to),
  );

  return (
    <>
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
                      <SidebarMenuButton
                        asChild
                        isActive={active}
                        tooltip={t(`nav.${item.key}`)}
                        // A tint of 1.13:1 is not an indicator, and hovering any
                        // item reproduced it exactly. The border and the colour
                        // are 6.5:1 and belong to the current section alone.
                        className="data-[active=true]:border-l-2 data-[active=true]:border-primary data-[active=true]:text-primary"
                      >
                        <NavLink
                          to={item.to}
                          end={item.to === '/'}
                          onClick={() => setOpenMobile(false)}
                        >
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
        {/* Never hidden when the rail collapses: this holds the only way to
            sign out, the collapsed state is remembered across reloads, and a
            person who collapsed the rail once could not sign out again. */}
        <SidebarFooter className="gap-2 px-3 py-3 group-data-[collapsible=icon]:px-1">
          <span className="truncate text-sm text-muted-foreground group-data-[collapsible=icon]:hidden">
            {displayName}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={onLogout}
            title={t('nav.logout')}
            className="group-data-[collapsible=icon]:h-8 group-data-[collapsible=icon]:w-8 group-data-[collapsible=icon]:p-0"
          >
            <LogOut className="size-4 shrink-0" />
            <span className="group-data-[collapsible=icon]:sr-only">{t('nav.logout')}</span>
          </Button>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>
      <SidebarInset>
        <header className="flex items-center gap-2 border-b border-border px-4 py-2">
          {/* No aria-label here: the trigger carries its own screen-reader
              text, and a label on top of it would win and then drift. */}
          <SidebarTrigger />
          {/* The page's own heading. Without it every page is a run of h2s
              with no level above them, and nothing names the page at all. */}
          <h1 className="text-base font-semibold">
            {current ? t(`nav.${current.key}`) : t('app.name')}
          </h1>
        </header>
        <ErrorNotice error={workspaces.error} />
        <div id="main" tabIndex={-1} className="grid gap-4 p-4 sm:p-6">
          <Outlet />
        </div>
      </SidebarInset>
    </>
  );
}
