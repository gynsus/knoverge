import type { MembershipRole, WorkspaceListEntry } from '@knoverge/contracts';
import { useQuery } from '@tanstack/react-query';
import { Bot, Clock3, Database, MoreHorizontal, Plus, Search, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { relativeTime } from '@/lib/relative-time';
import { adminApi } from '../api/admin.ts';
import { useWorkspaceContext } from '../auth/use-workspace.ts';
import { ErrorNotice } from '../components/ErrorNotice.tsx';

const WORKSPACES_KEY = ['workspaces-list'] as const;

const ROLES: MembershipRole[] = ['owner', 'admin', 'reviewer', 'viewer'];
type Sort = 'activity' | 'name' | 'items';

/**
 * Every workspace this person belongs to.
 *
 * What `/workspaces` used to do was open the settings of whichever workspace
 * happened to be selected, which answered a question nobody had asked: you
 * arrive here to choose between workspaces or to see what you have, not to
 * rename the one you are already in. The settings moved to a page of their
 * own and this is the list.
 *
 * Filtering and sorting happen here rather than on the server. A person
 * belongs to a handful of workspaces, the list arrives whole, and a round
 * trip per keystroke would buy nothing.
 */
export function WorkspacesPage() {
  const { t, i18n } = useTranslation();
  const workspaces = useWorkspaceContext();
  const [query, setQuery] = useState('');
  const [role, setRole] = useState<'all' | MembershipRole>('all');
  const [sort, setSort] = useState<Sort>('activity');

  const list = useQuery({
    queryKey: WORKSPACES_KEY,
    queryFn: ({ signal }) => adminApi.workspace.list(signal),
  });

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = (list.data?.workspaces ?? []).filter(
      (w) =>
        (needle === '' ||
          w.name.toLowerCase().includes(needle) ||
          w.slug.toLowerCase().includes(needle) ||
          (w.description ?? '').toLowerCase().includes(needle)) &&
        (role === 'all' || w.role === role),
    );
    const byActivity = (w: WorkspaceListEntry) =>
      w.last_activity_at === null ? 0 : new Date(w.last_activity_at).getTime();
    return [...matches].sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name, i18n.language);
      if (sort === 'items') return b.item_count - a.item_count;
      return byActivity(b) - byActivity(a);
    });
  }, [list.data, query, role, sort, i18n.language]);

  const filtered = query !== '' || role !== 'all';
  const reset = () => {
    setQuery('');
    setRole('all');
  };
  // The server refuses anyone without workspace.admin, so the interface asks
  // the same question rather than offering a button that only fails.
  const canCreate = workspaces.can('workspace.admin');

  return (
    <div className="grid gap-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="grid gap-1.5">
          <h2 className="text-2xl font-semibold tracking-tight">{t('workspaces.title')}</h2>
          <p className="max-w-2xl text-sm text-muted-foreground">{t('workspaces.intro')}</p>
        </div>
        {canCreate && (
          <Button asChild className="shrink-0">
            <Link to="/workspaces/new">
              <Plus className="size-4" aria-hidden="true" />
              {t('workspace.create')}
            </Link>
          </Button>
        )}
      </div>

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="relative min-w-0 flex-1 lg:max-w-md">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={t('workspaces.search')}
            placeholder={t('workspaces.search')}
            className="pr-9 pl-9"
          />
          {query !== '' && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label={t('workspaces.search_clear')}
              className="absolute top-1/2 right-3 -translate-y-1/2 rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3 sm:flex">
          <Select
            value={role}
            onChange={(e) => setRole(e.target.value as 'all' | MembershipRole)}
            aria-label={t('workspaces.filter_role')}
            className="sm:w-44"
          >
            <option value="all">{t('workspaces.all_roles')}</option>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {t(`roles.${r}`)}
              </option>
            ))}
          </Select>
          <Select
            value={sort}
            onChange={(e) => setSort(e.target.value as Sort)}
            aria-label={t('workspaces.sort')}
            className="sm:w-52"
          >
            <option value="activity">{t('workspaces.sort_activity')}</option>
            <option value="name">{t('workspaces.sort_name')}</option>
            <option value="items">{t('workspaces.sort_items')}</option>
          </Select>
        </div>
      </div>

      <ErrorNotice error={list.isError ? list.error : undefined} />
      {list.isPending && <p role="status">{t('common.loading')}</p>}

      {list.data && (
        <>
          <div className="flex min-h-8 items-center justify-between">
            {/* Announced, because the number changes as somebody types and
                nothing else would say the list had shrunk. */}
            <p role="status" className="text-sm text-muted-foreground">
              {t('workspaces.count', { count: visible.length })}
            </p>
            {/* Not when the grid is empty: the empty state below offers the
                same button, and two identical controls a few lines apart make
                somebody wonder which one is the real one. */}
            {filtered && visible.length > 0 && (
              <Button variant="ghost" size="sm" onClick={reset} className="text-muted-foreground">
                {t('workspaces.reset_filters')}
              </Button>
            )}
          </div>

          {visible.length > 0 ? (
            <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {visible.map((workspace) => (
                <li key={workspace.id} className="grid">
                  <WorkspaceCard
                    workspace={workspace}
                    current={workspace.id === workspaces.selectedId}
                    onSelect={workspaces.select}
                  />
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState filtered={filtered} onReset={reset} canCreate={canCreate} />
          )}
        </>
      )}
    </div>
  );
}

function WorkspaceCard({
  workspace,
  current,
  onSelect,
}: {
  workspace: WorkspaceListEntry;
  current: boolean;
  onSelect: (id: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();

  /** Moving into a workspace is what makes every later request name it. */
  const go = (to: string) => {
    if (!current) onSelect(workspace.id);
    void navigate(to);
  };

  return (
    <Card className="group relative grid grid-rows-[auto_1fr] transition-colors focus-within:ring-2 focus-within:ring-ring hover:border-foreground/20">
      <CardHeader className="gap-3 pb-4">
        <div className="flex items-start justify-between gap-3">
          <div className="grid min-w-0 gap-1.5">
            <CardTitle className="truncate text-lg">
              {/* One real link, stretched over the card. A div with onClick
                  looks the same to a pointer and does not exist to a keyboard
                  or a screen reader. */}
              <button
                type="button"
                onClick={() => go('/')}
                className="text-left after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
              >
                {workspace.name}
              </button>
            </CardTitle>
            <CardDescription className="line-clamp-2 min-h-10 leading-5">
              {workspace.description ?? t('workspaces.no_description')}
            </CardDescription>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              {/* Above the stretched link, or the card's own click would win. */}
              <Button
                variant="ghost"
                size="sm"
                aria-label={t('workspaces.actions', { name: workspace.name })}
                className="relative z-10 -mt-1 -mr-1 shrink-0 px-2"
              >
                <MoreHorizontal className="size-4" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => go('/')}>{t('workspaces.open')}</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => go('/workspaces/settings')}>
                {t('workspaces.settings')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </CardHeader>

      <CardContent className="grid content-end gap-5">
        <div className="flex flex-wrap items-center gap-2">
          {current && <Badge>{t('workspaces.current')}</Badge>}
          <Badge variant="outline">{t(`roles.${workspace.role}`)}</Badge>
          <Badge variant="outline" className="font-mono font-normal">
            {workspace.slug}
          </Badge>
        </div>

        <div className="grid grid-cols-2 gap-3 text-sm text-muted-foreground">
          <span className="flex items-center gap-2">
            <Database className="size-4 shrink-0" aria-hidden="true" />
            {t('workspaces.items', { count: workspace.item_count })}
          </span>
          <span className="flex items-center gap-2">
            <Bot className="size-4 shrink-0" aria-hidden="true" />
            {t('workspaces.agents', { count: workspace.agent_count })}
          </span>
        </div>

        <p className="flex items-center gap-2 border-t border-border pt-4 text-xs text-muted-foreground">
          <Clock3 className="size-3.5 shrink-0" aria-hidden="true" />
          {workspace.last_activity_at === null
            ? t('workspaces.never_active')
            : t('workspaces.updated', {
                when: relativeTime(workspace.last_activity_at, i18n.language),
              })}
        </p>
      </CardContent>
    </Card>
  );
}

function EmptyState({
  filtered,
  onReset,
  canCreate,
}: {
  filtered: boolean;
  onReset: () => void;
  canCreate: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid min-h-72 place-items-center gap-4 rounded-lg border border-dashed border-border px-6 py-12 text-center">
      <span className="grid size-11 place-items-center rounded-lg bg-muted">
        <Database className="size-5 text-muted-foreground" aria-hidden="true" />
      </span>
      <div className="grid gap-1">
        <h3 className="font-medium">
          {filtered ? t('workspaces.empty_filtered') : t('workspaces.empty')}
        </h3>
        <p className="mx-auto max-w-sm text-sm text-muted-foreground">
          {filtered ? t('workspaces.empty_filtered_hint') : t('workspaces.empty_hint')}
        </p>
      </div>
      {filtered ? (
        <Button variant="outline" onClick={onReset}>
          {t('workspaces.reset_filters')}
        </Button>
      ) : (
        canCreate && (
          <Button asChild>
            <Link to="/workspaces/new">
              <Plus className="size-4" aria-hidden="true" />
              {t('workspace.create')}
            </Link>
          </Button>
        )
      )}
    </div>
  );
}
