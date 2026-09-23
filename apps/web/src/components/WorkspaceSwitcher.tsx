import { ChevronsUpDown, Plus, Settings2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar';
import type { WorkspaceContext } from '../auth/use-workspace.ts';

/**
 * Up to two letters, for the square that stands in for the workspace when the
 * rail is collapsed. Taken from word starts rather than the first two
 * characters, so "Pixel Brisbane" reads as PB and not PI.
 */
function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.slice(0, 2).map((word) => [...word][0] ?? '');
  return (letters.join('') || '?').toUpperCase();
}

/**
 * Which workspace the interface is showing, and how to move between them.
 *
 * Shown even when there is only one. A control that appears the day a second
 * workspace exists is a control nobody finds, and the single-workspace case is
 * exactly where somebody needs to be told that what they are looking at is one
 * workspace among possible others — and where the way to make the second one
 * lives. It is also the answer to "where am I", which a person coming back to
 * a tab asks more often than "take me elsewhere".
 *
 * A menu rather than a `<select>`: the list is not only a list. It carries the
 * two things somebody reaches this control to do that a form field cannot
 * hold — settings for the workspace they are in, and creating another.
 */
export function WorkspaceSwitcher({ workspaces }: { workspaces: WorkspaceContext }) {
  const { t } = useTranslation();
  const { isMobile, setOpenMobile } = useSidebar();
  const current =
    workspaces.available.find((w) => w.id === workspaces.selectedId) ?? workspaces.available[0];
  if (!current) return null;

  // The server accepts a creator who administers any workspace; this asks
  // about the current one, which is the only one the interface has an answer
  // for. The effect is conservative: never offered where it would be refused.
  const canCreate = workspaces.can('workspace.admin');

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              tooltip={current.name}
              className="data-[state=open]:bg-sidebar-accent"
            >
              <span
                aria-hidden="true"
                className="flex aspect-square size-8 shrink-0 items-center justify-center rounded-md bg-primary text-xs font-semibold text-primary-foreground"
              >
                {initials(current.name)}
              </span>
              <span className="grid flex-1 text-left leading-tight group-data-[collapsible=icon]:hidden">
                <span className="truncate text-sm font-medium">{current.name}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {t(`roles.${current.role}`)}
                </span>
              </span>
              <ChevronsUpDown
                aria-hidden="true"
                className="ml-auto size-4 shrink-0 text-muted-foreground group-data-[collapsible=icon]:hidden"
              />
              {/* The button's accessible name. The visible text above says the
                  name and the role but never what the control does, and on a
                  collapsed rail it says nothing at all. */}
              <span className="sr-only">{t('nav.workspace_switch', { name: current.name })}</span>
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side={isMobile ? 'bottom' : 'right'} className="w-64">
            <DropdownMenuLabel>{t('nav.workspaces')}</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={workspaces.selectedId ?? ''}
              onValueChange={(id) => {
                if (id !== workspaces.selectedId) workspaces.select(id);
                setOpenMobile(false);
              }}
            >
              {workspaces.available.map((w) => (
                <DropdownMenuRadioItem key={w.id} value={w.id}>
                  <span className="grid min-w-0 leading-tight">
                    <span className="truncate">{w.name}</span>
                    <span className="truncate text-xs text-muted-foreground">{w.slug}</span>
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            {/* Straight to the drawer for the workspace they are in, rather
                than to a list they would have to find it in again. */}
            <DropdownMenuItem asChild>
              <Link to={`/workspaces?edit=${current.id}`} onClick={() => setOpenMobile(false)}>
                <Settings2 aria-hidden="true" />
                {t('nav.workspace_settings')}
              </Link>
            </DropdownMenuItem>
            {canCreate && (
              <DropdownMenuItem asChild>
                <Link to="/workspaces?new" onClick={() => setOpenMobile(false)}>
                  <Plus aria-hidden="true" />
                  {t('workspace.create')}
                </Link>
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
