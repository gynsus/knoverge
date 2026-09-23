import type { MembershipRole, WorkspaceListEntry } from '@knoverge/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Clock3, Database, MoreHorizontal, Plus, Search, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router';

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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Toast } from '@/components/ui/toast';
import { relativeTime } from '@/lib/relative-time';
import { draftOf, emptyWorkspaceDraft, type WorkspaceDraft } from '@/lib/workspace-draft';
import { adminApi } from '../api/admin.ts';
import { useAuth } from '../auth/use-auth.ts';
import { WORKSPACE_KEY, useWorkspaceContext } from '../auth/use-workspace.ts';
import { WorkspaceDetails } from '../components/workspaces/WorkspaceDetails.tsx';
import { WorkspaceSheet } from '../components/workspaces/WorkspaceSheet.tsx';
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
  const client = useQueryClient();
  const navigate = useNavigate();
  const auth = useAuth();
  // The two forms are in the address, so the switcher can link straight to
  // them and a reload does not lose which one was open. Which workspace is
  // being looked at is not: it is a glance, not a place.
  const [params, setParams] = useSearchParams();
  const [inspecting, setInspecting] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ message: string; tone: 'status' | 'error' } | null>(null);
  const [query, setQuery] = useState('');
  const [role, setRole] = useState<'all' | MembershipRole>('all');
  const [sort, setSort] = useState<Sort>('activity');

  const list = useQuery({
    queryKey: WORKSPACES_KEY,
    queryFn: ({ signal }) => adminApi.workspace.list(signal),
  });
  const all = useMemo(() => list.data?.workspaces ?? [], [list.data]);

  /**
   * Moving into a workspace is what makes every later request name it.
   * Navigating without it would show one workspace's rows under another's
   * name, and post ids from one with the other's header.
   */
  const go = (id: string, to: string) => {
    if (id !== workspaces.selectedId) workspaces.select(id);
    void navigate(to);
  };

  const inspected = all.find((w) => w.id === inspecting) ?? null;
  const editingId = params.get('edit');
  const editing = all.find((w) => w.id === editingId) ?? null;
  const creating = params.has('new');

  const closeForm = () => {
    const next = new URLSearchParams(params);
    next.delete('new');
    next.delete('edit');
    setParams(next, { replace: true });
  };

  const create = useMutation({
    mutationFn: (draft: WorkspaceDraft) =>
      adminApi.workspace.create({
        slug: draft.slug,
        name: draft.name,
        default_language: draft.language,
        ...(draft.description ? { description: draft.description } : {}),
      }),
    onSuccess: async (result) => {
      // The session has to see the membership before the choice can name it.
      await auth.refresh();
      workspaces.select(result.workspace.id);
      closeForm();
      setNotice({
        message: t('workspaces.created', { name: result.workspace.name }),
        tone: 'status',
      });
      void navigate('/', { replace: true });
    },
  });

  const save = useMutation({
    mutationFn: (draft: WorkspaceDraft) =>
      adminApi.workspace.update({
        name: draft.name,
        description: draft.description || null,
        default_language: draft.language,
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: WORKSPACES_KEY });
      await client.invalidateQueries({ queryKey: WORKSPACE_KEY });
      closeForm();
      setNotice({ message: t('workspaces.saved'), tone: 'status' });
    },
  });

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = all.filter(
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
  }, [all, query, role, sort, i18n.language]);

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
            <Link to="/workspaces?new">
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
                    onInspect={() => setInspecting(workspace.id)}
                    onGo={(to) => go(workspace.id, to)}
                  />
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState filtered={filtered} onReset={reset} canCreate={canCreate} />
          )}
        </>
      )}

      <Sheet open={inspected !== null} onOpenChange={(open) => !open && setInspecting(null)}>
        <SheetContent side="right" className="w-full gap-0 overflow-y-auto sm:max-w-md">
          <SheetHeader>
            <SheetTitle>{inspected?.name ?? t('workspaces.title')}</SheetTitle>
            <SheetDescription className="sr-only">{t('workspaces.intro')}</SheetDescription>
          </SheetHeader>
          {inspected && (
            <WorkspaceDetails
              workspace={inspected}
              current={inspected.id === workspaces.selectedId}
              // Settings are the workspace's own, so they are asked for in
              // the workspace: editing another one moves into it first.
              canAdminister={
                inspected.id === workspaces.selectedId
                  ? workspaces.can('workspace.admin')
                  : inspected.role === 'owner'
              }
              onOpen={() => go(inspected.id, '/')}
              onEdit={() => {
                if (inspected.id !== workspaces.selectedId) workspaces.select(inspected.id);
                setInspecting(null);
                setParams({ edit: inspected.id }, { replace: true });
              }}
              onMembers={() => go(inspected.id, '/workspaces/members')}
              onNotice={(message, tone) => setNotice({ message, tone })}
            />
          )}
        </SheetContent>
      </Sheet>

      <WorkspaceSheet
        open={creating || editing !== null}
        onOpenChange={(open) => !open && closeForm()}
        editing={editing}
        initial={editing ? draftOf(editing) : emptyWorkspaceDraft}
        onSubmit={(draft) => (editing ? save.mutate(draft) : create.mutate(draft))}
        busy={create.isPending || save.isPending}
        error={editing ? save.error : create.error}
      />

      <Toast
        message={notice?.message ?? null}
        tone={notice?.tone ?? 'status'}
        onDismiss={() => setNotice(null)}
      />
    </div>
  );
}

function WorkspaceCard({
  workspace,
  current,
  onInspect,
  onGo,
}: {
  workspace: WorkspaceListEntry;
  current: boolean;
  /** Opens the panel that says what this workspace is. */
  onInspect: () => void;
  /** Moves into the workspace and goes somewhere in it. */
  onGo: (to: string) => void;
}) {
  const { t, i18n } = useTranslation();

  return (
    <Card className="group relative grid grid-rows-[auto_1fr] transition-colors focus-within:ring-2 focus-within:ring-ring hover:border-foreground/20">
      <CardHeader className="gap-3 pb-4">
        <div className="flex items-start justify-between gap-3">
          <div className="grid min-w-0 gap-1.5">
            <CardTitle className="truncate text-lg">
              {/* One real link, stretched over the card. A div with onClick
                  looks the same to a pointer and does not exist to a keyboard
                  or a screen reader. */}
              {/* Opens the panel rather than the workspace. Somebody
                  scanning a list is deciding which one they want, and being
                  moved into one because they looked at it is a surprise; the
                  menu and the panel both offer the move. */}
              <button
                type="button"
                onClick={onInspect}
                aria-label={t('workspaces.inspect', { name: workspace.name })}
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
              <DropdownMenuItem onSelect={() => onGo('/')}>{t('workspaces.open')}</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={onInspect}>{t('workspaces.details')}</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onGo('/workspaces/members')}>
                {t('workspace.members')}
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
            <Link to="/workspaces?new">
              <Plus className="size-4" aria-hidden="true" />
              {t('workspace.create')}
            </Link>
          </Button>
        )
      )}
    </div>
  );
}
