import type { ItemType, KnowledgeItemDetail, ReviewState } from '@knoverge/contracts';
import { ItemType as ItemTypes, ReviewState as ReviewStates } from '@knoverge/contracts';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Plus, Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldSet } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { adminApi } from '../api/admin.ts';
import { useWorkspaceContext } from '../auth/use-workspace.ts';
import { ErrorNotice } from '../components/ErrorNotice.tsx';
import { KnowledgeRow, type RowItem } from '../components/knowledge/KnowledgeRow.tsx';
import { TAXONOMY_KEY } from '@/lib/query-keys';

const ITEMS_KEY = ['knowledge', 'items'] as const;

/** The fields a person edits. Everything else follows from them. */
interface Draft {
  title: string;
  body: string;
  type: ItemType;
  categories: string;
  tags: string;
}

const emptyDraft: Draft = { title: '', body: '', type: 'fact', categories: '', tags: '' };

const listOf = (value: string): string[] =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');

const draftOf = (item: KnowledgeItemDetail): Draft => ({
  title: item.title,
  body: item.body,
  type: item.type,
  categories: item.categories.join(', '),
  tags: item.tags.join(', '),
});

/**
 * Reading and writing knowledge.
 *
 * An edit carries the revision and hash it was based on, so two people editing
 * one item ends in a conflict the second one is told about rather than in the
 * first one's work disappearing.
 */
/**
 * The editor for one item.
 *
 * Its own component with a key on the item id, so the draft starts from the
 * item it was given. Synchronising it from an effect instead is the pattern
 * that renders twice and is wrong on the first pass.
 */
function ItemEditor({
  item,
  truncated,
  mayWrite,
  onChanged,
  onClose,
}: {
  item: KnowledgeItemDetail;
  /** Whether the body is only part of what the item holds. */
  truncated: boolean;
  mayWrite: boolean;
  onChanged: () => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<Draft>(() => draftOf(item));
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);

  const revisions = useQuery({
    queryKey: [...ITEMS_KEY, item.id, 'revisions'],
    queryFn: ({ signal }) => adminApi.knowledge.revisions(item.id, signal),
  });

  const base = {
    item_id: item.id,
    base_revision_id: item.current_revision_id,
    base_content_hash: item.content_hash,
  };
  const save = useMutation({
    mutationFn: () =>
      adminApi.knowledge.update({
        ...base,
        title: draft.title,
        body: draft.body,
        type: draft.type,
        categories: listOf(draft.categories),
        tags: listOf(draft.tags),
      }),
    onSuccess: onChanged,
  });
  const remove = useMutation({
    mutationFn: () => adminApi.knowledge.remove(base),
    onSuccess: async () => {
      setConfirmingDelete(false);
      await onChanged();
    },
  });
  const restore = useMutation({
    mutationFn: () => adminApi.knowledge.restore(item.id),
    onSuccess: onChanged,
  });

  // The drawer is its own region, so the editor and the form for a new item
  // no longer share a page and "Text" no longer appears twice with nothing to
  // tell the two apart.
  return (
    <div className="grid content-start gap-3 p-4 sm:p-6">
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <Badge>{t(`knowledge.review.${item.review_state}`)}</Badge>
        <Badge>{t(`knowledge.evidence.${item.evidence_state}`)}</Badge>
        <small>{t('knowledge.revision', { number: item.revision_number })}</small>
      </p>
      {truncated && <p role="alert">{t('knowledge.truncated')}</p>}
      <FieldSet disabled={!mayWrite || truncated || save.isPending}>
        <Field label={t('knowledge.item_title')}>
          <Input
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            maxLength={300}
          />
        </Field>
        <Field label={t('knowledge.type')}>
          <Select
            value={draft.type}
            onChange={(e) => setDraft({ ...draft, type: e.target.value as ItemType })}
          >
            {ItemTypes.options.map((type) => (
              <option key={type} value={type}>
                {t(`knowledge.types.${type}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('knowledge.categories')} hint={t('knowledge.categories_hint')}>
          <Input
            value={draft.categories}
            onChange={(e) => setDraft({ ...draft, categories: e.target.value })}
          />
        </Field>
        <Field label={t('knowledge.tags')} hint={t('knowledge.tags_hint')}>
          <Input
            value={draft.tags}
            onChange={(e) => setDraft({ ...draft, tags: e.target.value })}
          />
        </Field>
        <Field label={t('knowledge.body')} hint={t('knowledge.body_hint')}>
          <Textarea
            rows={12}
            value={draft.body}
            onChange={(e) => setDraft({ ...draft, body: e.target.value })}
          />
        </Field>
      </FieldSet>
      <ErrorNotice error={save.error ?? remove.error ?? restore.error} />
      <div className="flex flex-wrap gap-2">
        {mayWrite && !truncated && item.status !== 'deleted' && (
          <Button type="button" onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? t('common.working') : t('knowledge.save')}
          </Button>
        )}
        {mayWrite && item.status === 'deleted' ? (
          <Button type="button" onClick={() => restore.mutate()} disabled={restore.isPending}>
            {t('knowledge.restore')}
          </Button>
        ) : mayWrite && confirmingDelete ? (
          <>
            <span className="self-center text-sm">{t('knowledge.confirm_delete')}</span>
            <Button
              variant="destructive"
              type="button"
              onClick={() => remove.mutate()}
              disabled={remove.isPending}
            >
              {t('knowledge.delete')}
            </Button>
            <Button variant="outline" type="button" onClick={() => setConfirmingDelete(false)}>
              {t('common.cancel')}
            </Button>
          </>
        ) : (
          mayWrite && (
            <Button type="button" onClick={() => setConfirmingDelete(true)}>
              {t('knowledge.delete')}
            </Button>
          )
        )}
        <Button variant="outline" type="button" onClick={onClose}>
          {t('common.close')}
        </Button>
      </div>

      <h3 className="mt-4 text-base font-semibold">{t('knowledge.history')}</h3>
      <ErrorNotice error={revisions.error} />
      <ul className="grid gap-1 text-sm">
        {revisions.data?.revisions.map((revision) => (
          <li key={revision.id} className="flex flex-wrap items-baseline gap-2">
            <span>{t('knowledge.revision', { number: revision.revision_number })}</span>
            <Badge>{t(`knowledge.kinds.${revision.change_kind}`)}</Badge>
            <small>{new Date(revision.created_at).toLocaleString()}</small>
            <code className="text-xs text-muted-foreground">{revision.git_commit.slice(0, 8)}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Reading and writing knowledge.
 *
 * An edit carries the revision and hash it was based on, so two people editing
 * one item ends in a conflict the second one is told about rather than in the
 * first one's work disappearing.
 */
export function KnowledgePage() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const workspaces = useWorkspaceContext();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [fresh, setFresh] = useState<Draft>(emptyDraft);
  const [params, setParams] = useSearchParams();
  const lastTrigger = useRef<HTMLElement | null>(null);

  // The toolbar is in the address, so a narrowed view is a link somebody can
  // be sent: "the unreviewed decisions in architecture" is a place.
  const query = params.get('q') ?? '';
  const category = params.get('category') ?? '';
  const type = params.get('type') ?? '';
  const state = params.get('state') ?? '';
  const filtered = query !== '' || category !== '' || type !== '' || state !== '';

  // Typed here, committed to the address after a pause: a round trip per
  // keystroke buys nothing, and a history entry per keystroke buys less.
  const [typed, setTyped] = useState(params.get('q') ?? '');
  const searchBox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const id = setTimeout(() => {
      const next = new URLSearchParams(window.location.search);
      if (typed.trim() === '') next.delete('q');
      else next.set('q', typed.trim());
      setParams(next, { replace: true });
    }, 250);
    return () => clearTimeout(id);
    // `params` is deliberately absent: it changes as a result of this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typed]);

  // `/` is where a developer's hand goes to search. Not when they are already
  // typing somewhere, which is how that shortcut becomes a nuisance.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
      event.preventDefault();
      searchBox.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value === '') next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };
  const resetFilters = () => {
    const next = new URLSearchParams(params);
    for (const key of ['q', 'category', 'type', 'state']) next.delete(key);
    setParams(next, { replace: true });
  };

  // The tree, for the category filter. Cheap and cached: a taxonomy is tens to
  // hundreds of rows and every other screen reads it too.
  const taxonomy = useQuery({
    queryKey: TAXONOMY_KEY,
    queryFn: ({ signal }) => adminApi.taxonomy.list(signal),
  });

  // Paged, because a knowledge base outgrows one page and a list that stops
  // at fifty while claiming to be complete is a list that hides things.
  const items = useInfiniteQuery({
    queryKey: [...ITEMS_KEY, category, type, state],
    queryFn: ({ pageParam, signal }) =>
      adminApi.knowledge.list(
        {
          cursor: pageParam as string | undefined,
          category: category || undefined,
          type: type || undefined,
          reviewState: state || undefined,
        },
        signal,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled: query === '',
  });

  // A query ranks; the filters narrow. Search answers both at once, so the
  // browse list steps aside rather than the two fighting over the same rows.
  const found = useQuery({
    queryKey: [...ITEMS_KEY, 'search', query, category, type, state],
    queryFn: () =>
      adminApi.knowledge.search({
        query,
        category_paths: category ? [category] : [],
        types: type ? [type as ItemType] : [],
        statuses: ['active'],
        languages: [],
        review_states: state ? [state as ReviewState] : [],
        include_disputed: true,
        limit: 50,
        include_snippets: true,
      }),
    enabled: query !== '',
  });

  const rows: RowItem[] = useMemo(() => {
    if (query !== '') {
      return (found.data?.results ?? []).map((hit) => ({
        id: hit.item_id,
        title: hit.title,
        type: hit.type,
        categories: hit.category_paths,
        reviewState: hit.review_state,
        evidenceState: hit.evidence_state,
        disputed: hit.disputed,
        updatedAt: hit.updated_at,
      }));
    }
    return (items.data?.pages.flatMap((page) => page.items) ?? []).map((entry) => ({
      id: entry.id,
      title: entry.title,
      type: entry.type,
      categories: entry.categories,
      reviewState: entry.review_state,
      evidenceState: entry.evidence_state,
      disputed: entry.disputed,
      updatedAt: entry.updated_at,
    }));
  }, [query, found.data, items.data]);

  const loading = query === '' ? items.isPending : found.isPending;
  const failure = query === '' ? items.error : found.error;
  const selected = useQuery({
    queryKey: [...ITEMS_KEY, selectedId],
    queryFn: ({ signal }) => adminApi.knowledge.get(selectedId as string, signal),
    enabled: selectedId !== null,
  });

  const refresh = async () => {
    await client.invalidateQueries({ queryKey: ITEMS_KEY });
  };
  const close = () => {
    setSelectedId(null);
    lastTrigger.current?.focus();
  };
  const mayWrite = workspaces.can('knowledge.write');

  const create = useMutation({
    mutationFn: () =>
      adminApi.knowledge.create({
        title: fresh.title,
        body: fresh.body,
        type: fresh.type,
        categories: listOf(fresh.categories),
        tags: listOf(fresh.tags),
        sources: [],
        relations: [],
      }),
    onSuccess: async () => {
      setFresh(emptyDraft);
      closeForm();
      await refresh();
    },
  });

  const submitNew = (event: FormEvent) => {
    event.preventDefault();
    create.mutate();
  };

  const creating = params.has('new');
  const closeForm = () => {
    const next = new URLSearchParams(params);
    next.delete('new');
    setParams(next, { replace: true });
  };

  return (
    <div className="grid gap-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="grid gap-1.5">
          <h2 className="text-2xl font-semibold tracking-tight">{t('knowledge.title')}</h2>
          <p className="max-w-2xl text-sm text-muted-foreground">{t('knowledge.intro')}</p>
        </div>
        {mayWrite && (
          <Button type="button" className="shrink-0" onClick={() => setParams({ new: '' })}>
            <Plus aria-hidden="true" className="size-4" />
            {t('knowledge.add')}
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
            ref={searchBox}
            type="search"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            aria-label={t('knowledge.search')}
            placeholder={t('knowledge.search')}
            className="pr-9 pl-9"
          />
          {typed !== '' && (
            <button
              type="button"
              onClick={() => setTyped('')}
              aria-label={t('knowledge.search_clear')}
              className="absolute top-1/2 right-3 -translate-y-1/2 rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          )}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Select
            value={category}
            onChange={(e) => setFilter('category', e.target.value)}
            aria-label={t('knowledge.filter_category')}
          >
            <option value="">{t('knowledge.all_categories')}</option>
            {(taxonomy.data?.categories ?? []).map((c) => (
              <option key={c.id} value={c.path}>
                {c.path}
              </option>
            ))}
          </Select>
          <Select
            value={type}
            onChange={(e) => setFilter('type', e.target.value)}
            aria-label={t('knowledge.filter_type')}
          >
            <option value="">{t('knowledge.all_types')}</option>
            {ItemTypes.options.map((option) => (
              <option key={option} value={option}>
                {t(`knowledge.types.${option}`)}
              </option>
            ))}
          </Select>
          <Select
            value={state}
            onChange={(e) => setFilter('state', e.target.value)}
            aria-label={t('knowledge.filter_state')}
          >
            <option value="">{t('knowledge.all_states')}</option>
            {ReviewStates.options.map((option) => (
              <option key={option} value={option}>
                {t(`knowledge.review.${option}`)}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <>
        <div className="flex min-h-8 items-center justify-between">
          {/* Announced, because the number changes as somebody types and
              nothing else would say the list had shrunk. */}
          <p role="status" className="text-sm text-muted-foreground">
            {query === ''
              ? t('knowledge.count', { count: rows.length })
              : t('knowledge.found', { count: rows.length })}
          </p>
          {filtered && rows.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={resetFilters}
              className="text-muted-foreground"
            >
              {t('knowledge.reset_filters')}
            </Button>
          )}
        </div>

        {loading && <p role="status">{t('common.loading')}</p>}
        <ErrorNotice error={failure} />
        {!loading && rows.length === 0 && (
          <div className="grid min-h-48 place-items-center gap-3 rounded-lg border border-dashed border-border p-6 text-center">
            <div className="grid gap-1">
              <h3 className="font-medium">
                {filtered ? t('knowledge.empty_filtered') : t('knowledge.empty')}
              </h3>
              <p className="mx-auto max-w-sm text-sm text-muted-foreground">
                {filtered ? t('knowledge.empty_filtered_hint') : t('knowledge.empty_hint')}
              </p>
            </div>
            {filtered && (
              <Button variant="outline" onClick={resetFilters}>
                {t('knowledge.reset_filters')}
              </Button>
            )}
          </div>
        )}
        <ul className="grid">
          {rows.map((row) => (
            <KnowledgeRow
              key={row.id}
              item={row}
              onOpen={() => {
                setSelectedId(row.id);
              }}
            />
          ))}
        </ul>
        {query === '' && items.hasNextPage && (
          <Button
            type="button"
            variant="outline"
            className="justify-self-start"
            onClick={() => void items.fetchNextPage()}
            disabled={items.isFetchingNextPage}
          >
            {items.isFetchingNextPage ? t('common.working') : t('common.load_more')}
          </Button>
        )}
      </>

      <Sheet open={selectedId !== null} onOpenChange={(open) => !open && close()}>
        <SheetContent side="right" className="w-full gap-0 overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>{selected.data?.item.title ?? t('knowledge.title')}</SheetTitle>
            <SheetDescription className="sr-only">{t('knowledge.intro')}</SheetDescription>
          </SheetHeader>
          <ErrorNotice error={selected.error} />
          {selected.isPending && selectedId !== null && (
            <p role="status" className="p-4">
              {t('common.loading')}
            </p>
          )}
          {selected.data && (
            <ItemEditor
              key={selected.data.item.id}
              item={selected.data.item}
              // Saving a slice would write it over the rest. The browser asks
              // for the whole body, so this never fires; it is here because
              // the cost of being wrong about that is somebody's document.
              truncated={selected.data.truncated}
              mayWrite={mayWrite}
              onChanged={refresh}
              onClose={close}
            />
          )}
        </SheetContent>
      </Sheet>

      <Sheet open={creating} onOpenChange={(open) => !open && closeForm()}>
        <SheetContent side="right" className="w-full gap-0 overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>{t('knowledge.add')}</SheetTitle>
            <SheetDescription>{t('knowledge.add_intro')}</SheetDescription>
          </SheetHeader>
          <form onSubmit={submitNew} className="grid gap-4 p-4">
            <FieldSet disabled={create.isPending}>
              <Field label={t('knowledge.item_title')}>
                <Input
                  value={fresh.title}
                  onChange={(e) => setFresh({ ...fresh, title: e.target.value })}
                  required
                  maxLength={300}
                />
              </Field>
              <Field label={t('knowledge.type')}>
                <Select
                  value={fresh.type}
                  onChange={(e) => setFresh({ ...fresh, type: e.target.value as ItemType })}
                >
                  {ItemTypes.options.map((type) => (
                    <option key={type} value={type}>
                      {t(`knowledge.types.${type}`)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('knowledge.categories')} hint={t('knowledge.categories_hint')}>
                <Input
                  value={fresh.categories}
                  onChange={(e) => setFresh({ ...fresh, categories: e.target.value })}
                />
              </Field>
              <Field label={t('knowledge.body')} hint={t('knowledge.body_hint')}>
                <Textarea
                  rows={6}
                  value={fresh.body}
                  onChange={(e) => setFresh({ ...fresh, body: e.target.value })}
                  required
                />
              </Field>
            </FieldSet>
            <ErrorNotice error={create.error} />
            <SheetFooter className="px-0">
              <Button type="button" variant="outline" onClick={closeForm}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" disabled={create.isPending || fresh.title.trim() === ''}>
                {create.isPending ? t('common.working') : t('knowledge.add')}
              </Button>
            </SheetFooter>
          </form>
        </SheetContent>
      </Sheet>
    </div>
  );
}
