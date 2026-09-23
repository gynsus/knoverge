import type { ItemType, KnowledgeItemDetail } from '@knoverge/contracts';
import { ItemType as ItemTypes } from '@knoverge/contracts';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Plus } from 'lucide-react';
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

  // Paged, because a knowledge base outgrows one page and a list that stops
  // at fifty while claiming to be complete is a list that hides things.
  const items = useInfiniteQuery({
    queryKey: ITEMS_KEY,
    queryFn: ({ pageParam, signal }) =>
      adminApi.knowledge.list(pageParam as string | undefined, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
  const listed = items.data?.pages.flatMap((page) => page.items) ?? [];
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

      <>
        {items.isPending && <p role="status">{t('common.loading')}</p>}
        <ErrorNotice error={items.error} />
        {items.data && listed.length === 0 && (
          <div className="grid min-h-40 place-items-center rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            {t('knowledge.empty')}
          </div>
        )}
        <ul className="grid gap-1">
          {listed.map((entry) => (
            <li key={entry.id} className="flex flex-wrap items-baseline gap-2">
              <Button
                type="button"
                variant="link"
                className="h-auto p-0 text-left"
                onClick={(event) => {
                  lastTrigger.current = event.currentTarget;
                  setSelectedId(entry.id);
                }}
              >
                {entry.title}
              </Button>
              <Badge>{t(`knowledge.types.${entry.type}`)}</Badge>
              {entry.status !== 'active' && (
                <Badge>{t(`knowledge.statuses.${entry.status}`)}</Badge>
              )}
              <code className="text-xs text-muted-foreground">{entry.markdown_path}</code>
            </li>
          ))}
        </ul>
        {items.hasNextPage && (
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
