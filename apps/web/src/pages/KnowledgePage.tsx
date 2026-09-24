import type { KnowledgeItemDetail } from '@knoverge/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';

import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { ACTORS_KEY, TAXONOMY_KEY } from '@/lib/query-keys';
import { adminApi } from '../api/admin.ts';
import { useWorkspaceContext } from '../auth/use-workspace.ts';
import { ErrorNotice } from '../components/ErrorNotice.tsx';
import { ItemDetails } from '../components/knowledge/ItemDetails.tsx';
import { ItemEditor } from '../components/knowledge/ItemEditor.tsx';
import { KnowledgeRow } from '../components/knowledge/KnowledgeRow.tsx';
import { KnowledgeToolbar } from '../components/knowledge/KnowledgeToolbar.tsx';
import { NewItemSheet } from '../components/knowledge/NewItemSheet.tsx';
import { ITEMS_KEY, useKnowledgeRows } from '../components/knowledge/useKnowledgeRows.ts';

/** How long typing settles before it becomes a request and a history entry. */
const TYPING_SETTLES_MS = 250;

/**
 * The knowledge of a workspace: what is there, and one item at a time.
 *
 * The narrowing lives in the address, so "the unreviewed decisions in
 * architecture" is a link somebody can be sent, and an item opens for reading
 * rather than for editing (WEB_UI.md rules 2, 2a and 2b).
 */
export function KnowledgePage() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const workspaces = useWorkspaceContext();
  const [params, setParams] = useSearchParams();
  const [editing, setEditing] = useState(false);
  const lastTrigger = useRef<HTMLElement | null>(null);

  /**
   * Which item is open, in the address.
   *
   * A knowledge item is the thing this product exists to hold, and the most
   * likely sentence anybody writes about one is "here is what we decided:
   * <link>". Rule 2's test is whether somebody else may need to arrive at the
   * same thing, and for this they will.
   */
  const selectedId = params.get('item');
  const setSelectedId = (itemId: string | null) => {
    const next = new URLSearchParams(params);
    if (itemId === null) next.delete('item');
    else next.set('item', itemId);
    setParams(next, { replace: true });
  };

  const query = params.get('q') ?? '';
  const category = params.get('category') ?? '';
  const type = params.get('type') ?? '';
  const state = params.get('state') ?? '';
  const narrowed = query !== '' || category !== '' || type !== '' || state !== '';

  // Typed here, committed to the address after a pause: a round trip per
  // keystroke buys nothing, and a history entry per keystroke buys less.
  const [typed, setTyped] = useState(query);
  useEffect(() => {
    const id = setTimeout(() => {
      // The functional form, so this reads whatever the address holds when it
      // fires rather than what it held when the effect was set up. Reading
      // `window.location` instead was the same idea and quietly wrong: it is
      // not where a router keeps the address, so everything else in it — the
      // filters, the item that is open — was dropped on the first keystroke.
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (typed.trim() === '') next.delete('q');
          else next.set('q', typed.trim());
          return next;
        },
        { replace: true },
      );
    }, TYPING_SETTLES_MS);
    return () => clearTimeout(id);
  }, [typed, setParams]);

  const setFilter = (key: 'category' | 'type' | 'state', value: string) => {
    const next = new URLSearchParams(params);
    if (value === '') next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };
  const reset = () => {
    setTyped('');
    const next = new URLSearchParams(params);
    for (const key of ['q', 'category', 'type', 'state']) next.delete(key);
    setParams(next, { replace: true });
  };

  // The tree, for the branch filter. Cheap and cached: a taxonomy is tens to
  // hundreds of rows and every other screen reads it too.
  const taxonomy = useQuery({
    queryKey: TAXONOMY_KEY,
    queryFn: ({ signal }) => adminApi.taxonomy.list(signal),
  });
  const categoryPaths = (taxonomy.data?.categories ?? []).map((c) => c.path);
  const actors = useQuery({
    queryKey: ACTORS_KEY,
    queryFn: ({ signal }) => adminApi.workspace.actors(signal),
  });
  const list = useKnowledgeRows({ query, category, type, state });

  const selected = useQuery({
    queryKey: [...ITEMS_KEY, selectedId],
    queryFn: ({ signal }) => adminApi.knowledge.get(selectedId as string, signal),
    enabled: selectedId !== null,
  });

  const refresh = () => client.invalidateQueries({ queryKey: ITEMS_KEY });
  const remove = useMutation({
    mutationFn: (item: KnowledgeItemDetail) =>
      adminApi.knowledge.remove({
        item_id: item.id,
        base_revision_id: item.current_revision_id,
        base_content_hash: item.content_hash,
      }),
    onSuccess: () => refresh(),
  });
  const restore = useMutation({
    mutationFn: (itemId: string) => adminApi.knowledge.restore(itemId),
    onSuccess: () => refresh(),
  });

  const close = () => {
    setSelectedId(null);
    setEditing(false);
    lastTrigger.current?.focus();
  };
  const mayWrite = workspaces.can('knowledge.write');
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

      <KnowledgeToolbar
        typed={typed}
        onType={setTyped}
        category={category}
        type={type}
        state={state}
        categories={categoryPaths}
        onFilter={setFilter}
      />

      <div className="flex min-h-8 items-center justify-between">
        {/* Announced, because the number changes as somebody types and nothing
            else would say the list had shrunk. */}
        <p role="status" className="text-sm text-muted-foreground">
          {query === ''
            ? t('knowledge.count', { count: list.rows.length })
            : t('knowledge.found', { count: list.rows.length })}
        </p>
        {narrowed && list.rows.length > 0 && (
          <Button variant="ghost" size="sm" onClick={reset} className="text-muted-foreground">
            {t('knowledge.reset_filters')}
          </Button>
        )}
      </div>

      {list.loading && <p role="status">{t('common.loading')}</p>}
      <ErrorNotice error={list.error} />
      {!list.loading && list.rows.length === 0 && (
        <div className="grid min-h-48 place-items-center gap-3 rounded-lg border border-dashed border-border p-6 text-center">
          <div className="grid gap-1">
            <h3 className="font-medium">
              {narrowed ? t('knowledge.empty_filtered') : t('knowledge.empty')}
            </h3>
            <p className="mx-auto max-w-sm text-sm text-muted-foreground">
              {narrowed ? t('knowledge.empty_filtered_hint') : t('knowledge.empty_hint')}
            </p>
          </div>
          {narrowed && (
            <Button variant="outline" onClick={reset}>
              {t('knowledge.reset_filters')}
            </Button>
          )}
        </div>
      )}
      <ul className="grid">
        {list.rows.map((row) => (
          <KnowledgeRow key={row.id} item={row} onOpen={() => setSelectedId(row.id)} />
        ))}
      </ul>
      {list.hasMore && (
        <Button
          type="button"
          variant="outline"
          className="justify-self-start"
          onClick={list.loadMore}
          disabled={list.loadingMore}
        >
          {list.loadingMore ? t('common.working') : t('common.load_more')}
        </Button>
      )}

      <Sheet open={selectedId !== null} onOpenChange={(open) => !open && close()}>
        <SheetContent side="right" className="w-full gap-0 overflow-y-auto sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle>{selected.data?.item.title ?? t('knowledge.title')}</SheetTitle>
            <SheetDescription className="sr-only">{t('knowledge.intro')}</SheetDescription>
          </SheetHeader>
          <ErrorNotice error={selected.error} />
          {selected.isPending && selectedId !== null && (
            <p role="status" className="p-4 sm:p-6">
              {t('common.loading')}
            </p>
          )}
          {selected.data &&
            (editing ? (
              <ItemEditor
                key={`${selected.data.item.id}:edit`}
                item={selected.data.item}
                // Saving a slice would write it over the rest. The browser asks
                // for the whole body, so this never fires; it is here because
                // the cost of being wrong about that is somebody's document.
                truncated={selected.data.truncated}
                mayWrite={mayWrite}
                categories={categoryPaths}
                onChanged={async () => {
                  setEditing(false);
                  await refresh();
                }}
                onCancel={(dirty) => {
                  if (dirty && !window.confirm(t('knowledge.discard'))) return;
                  setEditing(false);
                }}
              />
            ) : (
              <ItemDetails
                key={selected.data.item.id}
                item={selected.data.item}
                truncated={selected.data.truncated}
                mayWrite={mayWrite}
                actors={actors.data?.actors ?? []}
                onEdit={() => setEditing(true)}
                onDelete={() => remove.mutate(selected.data.item)}
                onRestore={() => restore.mutate(selected.data.item.id)}
                onOpenItem={(itemId) => {
                  // Following a relation moves the drawer to the other item
                  // rather than opening a second one over the first.
                  setEditing(false);
                  setSelectedId(itemId);
                }}
                busy={remove.isPending || restore.isPending}
                error={remove.error ?? restore.error}
              />
            ))}
        </SheetContent>
      </Sheet>

      <NewItemSheet
        open={creating}
        onClose={closeForm}
        onCreated={refresh}
        categories={categoryPaths}
      />
    </div>
  );
}
