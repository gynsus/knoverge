import type { CategorySummary } from '@knoverge/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { History, ListTree, Plus, Search, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Toast } from '@/components/ui/toast';
import {
  draftOf,
  emptyDraft,
  splitCommas,
  splitLines,
  type CategoryDraft,
} from '@/lib/category-draft';
import { ACTORS_KEY, TAXONOMY_HISTORY_KEY, TAXONOMY_KEY } from '@/lib/query-keys';
import { buildTree, matching, subtreeIds } from '@/lib/taxonomy-tree';
import { LARGE_BREAKPOINT, useBelow } from '@/hooks/use-mobile';
import { relativeTime } from '@/lib/relative-time';
import { adminApi } from '../api/admin.ts';
import { useWorkspaceContext } from '../auth/use-workspace.ts';
import { ErrorNotice } from '../components/ErrorNotice.tsx';
import { CategoryDetails } from '../components/taxonomy/CategoryDetails.tsx';
import { CategorySheet } from '../components/taxonomy/CategorySheet.tsx';
import { CategoryTree } from '../components/taxonomy/CategoryTree.tsx';
import { MergeDialog, MoveDialog } from '../components/taxonomy/TaxonomyDialogs.tsx';
import { ProposedCategory } from '../components/taxonomy/ProposedCategory.tsx';
import { TaxonomyHistory } from '../components/taxonomy/TaxonomyHistory.tsx';

type Shown = 'active' | 'all' | 'archived' | 'proposed';

/**
 * The taxonomy, as something to work with rather than a list with a form
 * under it.
 *
 * A category here is not a folder: it carries guidance that tells an agent
 * what belongs in it, aliases that let one be found under another name, and a
 * record of who made it. None of that fitted on a row, so the tree keeps the
 * shape and a panel beside it holds the category itself.
 *
 * Creating and editing moved into a sheet. The form used to hold the bottom
 * half of the screen whether or not anybody was filling it in, which is half
 * a screen not spent on the thing the page is for.
 */
export function TaxonomyPage() {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const workspaces = useWorkspaceContext();
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState<Shown>('active');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Null until somebody opens or closes something themselves; until then the
  // tree decides for itself, below.
  const [opened, setOpened] = useState<ReadonlySet<string> | null>(null);
  const [editing, setEditing] = useState<CategorySummary | null>(null);
  const [draft, setDraft] = useState<CategoryDraft>(emptyDraft);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [moving, setMoving] = useState<CategorySummary | null>(null);
  const [merging, setMerging] = useState<CategorySummary | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  /** Which proposed category is open, when one is instead of a real one. */
  const [proposalId, setProposalId] = useState<string | null>(null);
  // Below `lg` the tree takes the whole width and the detail panel is a sheet;
  // at or above it the panel is a column that is always there.
  const narrow = useBelow(LARGE_BREAKPOINT);
  const [notice, setNotice] = useState<{ message: string; tone: 'status' | 'error' } | null>(null);

  const taxonomy = useQuery({
    queryKey: TAXONOMY_KEY,
    queryFn: ({ signal }) => adminApi.taxonomy.list(signal),
  });
  /**
   * The categories an agent has asked for.
   *
   * A separate call rather than a filter over the tree, because a proposed
   * category is a proposal and not a category with a status: it has no id, no
   * path and no place in the tree until somebody makes it.
   */
  const proposed = useQuery({
    queryKey: ['proposals', 'categories'],
    queryFn: ({ signal }) => adminApi.proposals.list('pending', {}, signal),
    select: (answer) => answer.proposals.filter((p) => p.proposal_type === 'category_create'),
  });
  const openProposal = useQuery({
    queryKey: ['proposals', 'one', proposalId],
    queryFn: ({ signal }) => adminApi.proposals.get(proposalId as string, signal),
    enabled: proposalId !== null,
  });

  const actors = useQuery({
    queryKey: ACTORS_KEY,
    queryFn: ({ signal }) => adminApi.workspace.actors(signal),
  });

  const refresh = async () => {
    await client.invalidateQueries({ queryKey: TAXONOMY_KEY });
    await client.invalidateQueries({ queryKey: TAXONOMY_HISTORY_KEY });
  };
  const done = (message: string) => {
    setNotice({ message, tone: 'status' });
    setSheetOpen(false);
    setMoving(null);
    setMerging(null);
  };

  const all = useMemo(() => taxonomy.data?.categories ?? [], [taxonomy.data]);
  const categories = useMemo(
    () =>
      all.filter((c) =>
        shown === 'all'
          ? true
          : shown === 'archived'
            ? c.status !== 'active'
            : c.status === 'active',
      ),
    [all, shown],
  );
  const { visible, matched } = useMemo(() => matching(categories, query), [categories, query]);
  const tree = useMemo(() => buildTree(categories), [categories]);
  const selected = all.find((c) => c.id === selectedId) ?? null;
  const canManage = workspaces.can('taxonomy.manage');

  /**
   * A small taxonomy opens itself; a large one does not.
   *
   * Everything collapsed means a first visit shows a handful of words and no
   * structure, which is the opposite of what a tree is for. Everything
   * expanded at two hundred categories is a wall. The line is drawn at a
   * screenful or so, and either way the first thing somebody does — opening
   * or closing anything — takes the decision back.
   */
  const defaultOpen = useMemo(
    () =>
      new Set(
        categories.length <= 40
          ? categories.map((c) => c.id)
          : categories.filter((c) => c.parent_id === null).map((c) => c.id),
      ),
    [categories],
  );
  // A search opens whatever it needs to show its matches; outside a search the
  // person's own open and closed branches are what is on screen.
  const expanded = query.trim() === '' ? (opened ?? defaultOpen) : visible;
  /** The proposals on show, which is all of them unless one filter hides them. */
  const waiting = proposed.data ?? [];
  const filtered = query.trim() !== '' || shown !== 'active';
  const reset = () => {
    setQuery('');
    setShown('active');
  };
  const lastChange = all.reduce<string | null>(
    (newest, c) => (newest === null || c.updated_at > newest ? c.updated_at : newest),
    null,
  );

  const create = useMutation({
    mutationFn: (next: CategoryDraft) => {
      const parent = all.find((c) => c.id === next.parentId);
      return adminApi.taxonomy.create({
        name: next.name,
        ...(parent ? { parent_path: parent.path } : {}),
        ...(next.description ? { description: next.description } : {}),
        inclusion_guidance: splitLines(next.inclusion),
        exclusion_guidance: splitLines(next.exclusion),
        aliases: splitCommas(next.aliases),
      });
    },
    onSuccess: async (result) => {
      await refresh();
      setSelectedId(result.category.id);
      done(t('taxonomy.created', { name: result.category.name }));
    },
  });

  const save = useMutation({
    mutationFn: (next: CategoryDraft) =>
      adminApi.taxonomy.update({
        category_id: (editing as CategorySummary).id,
        name: next.name,
        slug: next.slug,
        description: next.description || null,
        inclusion_guidance: splitLines(next.inclusion),
        exclusion_guidance: splitLines(next.exclusion),
        aliases: splitCommas(next.aliases),
      }),
    onSuccess: async (result) => {
      await refresh();
      done(t('taxonomy.saved', { name: result.category.name }));
    },
  });

  const move = useMutation({
    mutationFn: (parentId: string | null) =>
      adminApi.taxonomy.move({
        category_id: (moving as CategorySummary).id,
        new_parent_id: parentId as CategorySummary['parent_id'],
      }),
    onSuccess: async (result) => {
      await refresh();
      done(t('taxonomy.moved', { path: result.category.path }));
    },
  });

  const merge = useMutation({
    mutationFn: (intoId: string) =>
      adminApi.taxonomy.merge({
        category_id: (merging as CategorySummary).id,
        into_category_id: intoId as CategorySummary['id'],
      }),
    onSuccess: async (result) => {
      await refresh();
      setSelectedId(result.category.id);
      done(t('taxonomy.merged', { name: result.category.name }));
    },
  });

  const archive = useMutation({
    mutationFn: (category: CategorySummary) => adminApi.taxonomy.archive(category.id),
    onSuccess: async () => {
      await refresh();
      done(t('taxonomy.archived'));
    },
  });
  const restore = useMutation({
    mutationFn: (category: CategorySummary) => adminApi.taxonomy.restore(category.id),
    onSuccess: async () => {
      await refresh();
      done(t('taxonomy.restored'));
    },
  });

  const openSheet = (category: CategorySummary | null, parent: CategorySummary | null) => {
    setEditing(category);
    setDraft(category ? draftOf(category) : { ...emptyDraft, parentId: parent?.id ?? null });
    setSheetOpen(true);
  };

  const select = (category: CategorySummary) => {
    setSelectedId(category.id);
    setDetailsOpen(true);
  };

  const actions = {
    canManage,
    onSelect: select,
    onAddChild: (parent: CategorySummary) => openSheet(null, parent),
    onEdit: (category: CategorySummary) => openSheet(category, null),
    onMove: setMoving,
    onMerge: setMerging,
    onArchive: (category: CategorySummary) => archive.mutate(category),
    onRestore: (category: CategorySummary) => restore.mutate(category),
  };

  // A proposal wins where both are open: it is what somebody just chose, and
  // the category they were looking at is still in the tree behind it.
  const details = openProposal.data ? (
    <ProposedCategory
      proposal={openProposal.data.proposal}
      proposer={
        actors.data?.actors.find((a) => a.id === openProposal.data.proposal.proposed_by_actor_id)
          ?.display_name ?? openProposal.data.proposal.proposed_by_actor_id
      }
      categories={all}
      onCreate={(payload) => {
        const parent = all.find((c) => c.path === payload.parentPath) ?? null;
        setProposalId(null);
        setDraft({
          ...emptyDraft,
          name: payload.name,
          description: payload.description ?? '',
          parentId: parent?.id ?? null,
        });
        setEditing(null);
        setSheetOpen(true);
      }}
      onResolved={async () => {
        setProposalId(null);
        await client.invalidateQueries({ queryKey: ['proposals'] });
      }}
    />
  ) : (
    selected && (
      <CategoryDetails
        category={selected}
        categories={all}
        actors={actors.data?.actors ?? []}
        canManage={canManage}
        onEdit={() => openSheet(selected, null)}
        onAddChild={() => openSheet(null, selected)}
        onNotice={(message, tone) => setNotice({ message, tone })}
        childCount={all.filter((c) => c.parent_id === selected.id).length}
      />
    )
  );

  return (
    <div className="grid gap-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="grid gap-1.5">
          <h2 className="text-2xl font-semibold tracking-tight">{t('taxonomy.title')}</h2>
          <p className="max-w-2xl text-sm text-muted-foreground">{t('taxonomy.intro')}</p>
          {taxonomy.data && (
            <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="outline">
                {t('taxonomy.version', { version: taxonomy.data.taxonomy_version })}
              </Badge>
              {lastChange && (
                <span>
                  {t('taxonomy.updated', { when: relativeTime(lastChange, i18n.language) })}
                </span>
              )}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={() => setHistoryOpen(true)}>
            <History aria-hidden="true" className="size-4" />
            {t('taxonomy.history')}
          </Button>
          {canManage && (
            <Button type="button" onClick={() => openSheet(null, null)}>
              <Plus aria-hidden="true" className="size-4" />
              {t('taxonomy.new_category')}
            </Button>
          )}
        </div>
      </div>

      {/* Taxonomy proposals are decided in the review inbox, which is where
          every other proposal is decided. A second place to accept them would
          be a second copy of the same rules. */}
      {workspaces.can('knowledge.approve') && (
        <p className="text-sm text-muted-foreground">
          {t('taxonomy.proposals_hint')}{' '}
          <Link to="/review" className="underline underline-offset-4">
            {t('nav.review')}
          </Link>
        </p>
      )}

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
            aria-label={t('taxonomy.search')}
            placeholder={t('taxonomy.search')}
            className="pr-9 pl-9"
          />
          {query !== '' && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label={t('taxonomy.search_clear')}
              className="absolute top-1/2 right-3 -translate-y-1/2 rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-3">
          <Select
            value={shown}
            onChange={(e) => setShown(e.target.value as Shown)}
            aria-label={t('taxonomy.filter_status')}
            className="sm:w-44"
          >
            <option value="active">{t('taxonomy.only_active')}</option>
            <option value="proposed">{t('taxonomy.only_proposed')}</option>
            <option value="archived">{t('taxonomy.only_closed')}</option>
            <option value="all">{t('taxonomy.all_statuses')}</option>
          </Select>
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              setOpened((current) =>
                (current ?? defaultOpen).size > 0
                  ? new Set()
                  : new Set(categories.map((c) => c.id)),
              )
            }
          >
            <ListTree aria-hidden="true" className="size-4" />
            {expanded.size > 0 ? t('taxonomy.collapse_all') : t('taxonomy.expand_all')}
          </Button>
        </div>
      </div>

      <ErrorNotice error={taxonomy.isError ? taxonomy.error : undefined} />
      <ErrorNotice error={archive.error ?? restore.error} />
      {taxonomy.isPending && <p role="status">{t('common.loading')}</p>}

      {taxonomy.data && all.length > 0 && (
        <div className="flex min-h-8 flex-wrap items-center justify-between gap-2">
          {/* Announced, because a search changes it and nothing else on the
              screen would say the tree had shrunk. The two numbers are
              different questions: how much is in the tree, and how much of it
              the search actually found. */}
          <p role="status" className="text-sm text-muted-foreground">
            {t('taxonomy.count', { count: categories.length })}
            {query.trim() !== '' && ` · ${t('taxonomy.found', { count: matched.size })}`}
          </p>
          {filtered && (
            <Button variant="ghost" size="sm" onClick={reset} className="text-muted-foreground">
              {t('taxonomy.reset_filters')}
            </Button>
          )}
        </div>
      )}

      {taxonomy.data &&
        (all.length === 0 ? (
          <EmptyTaxonomy canManage={canManage} onCreate={() => openSheet(null, null)} />
        ) : (
          <div className="grid min-h-[32rem] overflow-hidden rounded-lg border border-border lg:grid-cols-[minmax(0,1fr)_22rem]">
            <section className="min-w-0 overflow-y-auto">
              {/* What an agent has asked for, above the tree it is not in
                  yet. A proposed category has no path and no place among the
                  real ones, and putting it there would claim it exists. */}
              {waiting.length > 0 && shown !== 'archived' && (
                <div className="grid gap-1 border-b border-border bg-muted/40 p-3">
                  <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                    {t('taxonomy.waiting_for_you', { count: waiting.length })}
                  </h3>
                  <ul className="grid">
                    {waiting.map((proposal) => (
                      <li key={proposal.id}>
                        <button
                          type="button"
                          onClick={() => {
                            setProposalId(proposal.id);
                            setDetailsOpen(true);
                          }}
                          aria-current={proposal.id === proposalId ? 'true' : undefined}
                          className={cn(
                            'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
                            'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
                            proposal.id === proposalId ? 'bg-accent' : 'hover:bg-muted',
                          )}
                        >
                          <span className="min-w-0 flex-1 truncate">
                            {proposal.title ?? t('taxonomy.untitled_proposal')}
                          </span>
                          <Badge variant="outline" className="shrink-0 font-normal">
                            {t('taxonomy.proposed')}
                          </Badge>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {tree.length === 0 ? (
                <p className="p-6 text-sm text-muted-foreground">{t('taxonomy.no_matches')}</p>
              ) : (
                <CategoryTree
                  nodes={tree}
                  selectedId={selectedId}
                  expanded={expanded}
                  matched={matched}
                  visible={query.trim() === '' ? new Set() : visible}
                  onToggle={(id, open) =>
                    setOpened((current) => {
                      const next = new Set(current ?? defaultOpen);
                      if (open) next.add(id);
                      else next.delete(id);
                      return next;
                    })
                  }
                  {...actions}
                />
              )}
            </section>
            {/* Below the large breakpoint the tree needs the whole width, so
                the panel becomes a sheet rather than a column squeezed to
                nothing. */}
            <aside className="hidden overflow-y-auto border-l border-border lg:block">
              {details ?? (
                <p className="p-6 text-sm text-muted-foreground">{t('taxonomy.choose_category')}</p>
              )}
            </aside>
          </div>
        ))}

      {/* Only where there is no column for it. A sheet hidden with a class is
          still a dialog: it draws its overlay through a portal the class does
          not reach, traps the focus, and locks the page's scrolling, none of
          which is visible. */}
      <Sheet open={narrow && detailsOpen && selected !== null} onOpenChange={setDetailsOpen}>
        <SheetContent side="right" className="w-full gap-0 overflow-y-auto sm:max-w-md">
          <SheetHeader className="sr-only">
            <SheetTitle>{selected?.name ?? t('taxonomy.title')}</SheetTitle>
          </SheetHeader>
          {details}
        </SheetContent>
      </Sheet>

      <CategorySheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        editing={editing}
        initial={draft}
        categories={all}
        forbiddenParents={editing ? subtreeIds(all, editing) : []}
        onSubmit={(next) => (editing ? save.mutate(next) : create.mutate(next))}
        busy={create.isPending || save.isPending}
        error={editing ? save.error : create.error}
      />
      <MoveDialog
        category={moving}
        categories={all}
        onClose={() => setMoving(null)}
        onConfirm={(parentId) => move.mutate(parentId)}
        busy={move.isPending}
        error={move.error}
      />
      <MergeDialog
        category={merging}
        categories={all}
        onClose={() => setMerging(null)}
        onConfirm={(intoId) => merge.mutate(intoId)}
        busy={merge.isPending}
        error={merge.error}
      />
      <TaxonomyHistory
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        actors={actors.data?.actors ?? []}
      />
      <Toast
        message={notice?.message ?? null}
        tone={notice?.tone ?? 'status'}
        onDismiss={() => setNotice(null)}
      />
    </div>
  );
}

function EmptyTaxonomy({ canManage, onCreate }: { canManage: boolean; onCreate: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="grid min-h-72 place-items-center gap-4 rounded-lg border border-dashed border-border px-6 py-12 text-center">
      <span className="grid size-11 place-items-center rounded-lg bg-muted">
        <ListTree aria-hidden="true" className="size-5 text-muted-foreground" />
      </span>
      <div className="grid gap-1">
        <h3 className="font-medium">{t('taxonomy.empty')}</h3>
        <p className="mx-auto max-w-sm text-sm text-muted-foreground">{t('taxonomy.empty_hint')}</p>
      </div>
      {canManage && (
        <Button type="button" onClick={onCreate}>
          <Plus aria-hidden="true" className="size-4" />
          {t('taxonomy.first_category')}
        </Button>
      )}
    </div>
  );
}
