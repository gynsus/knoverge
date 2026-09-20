import type { ItemType, KnowledgeItemDetail } from '@knoverge/contracts';
import { ItemType as ItemTypes } from '@knoverge/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { Field, FieldSet } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
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
  mayWrite,
  onChanged,
  onClose,
}: {
  item: KnowledgeItemDetail;
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

  // A named region, because the editor and the form for a new item carry the
  // same field labels: without one, "Text" appears twice on the page with
  // nothing to tell the two apart.
  return (
    <Card role="region" aria-labelledby="knowledge-detail-title" className="grid gap-3 p-4 sm:p-6">
      <CardTitle id="knowledge-detail-title" tabIndex={-1} ref={heading}>
        {item.title}
      </CardTitle>
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <Badge>{t(`knowledge.review.${item.review_state}`)}</Badge>
        <Badge>{t(`knowledge.evidence.${item.evidence_state}`)}</Badge>
        <small>{t('knowledge.revision', { number: item.revision_number })}</small>
      </p>
      <FieldSet disabled={!mayWrite || save.isPending}>
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
        {mayWrite && item.status !== 'deleted' && (
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
    </Card>
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
  const lastTrigger = useRef<HTMLElement | null>(null);

  const items = useQuery({
    queryKey: ITEMS_KEY,
    queryFn: ({ signal }) => adminApi.knowledge.list(signal),
  });
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
      await refresh();
    },
  });

  const submitNew = (event: FormEvent) => {
    event.preventDefault();
    create.mutate();
  };

  return (
    <>
      <Card aria-labelledby="knowledge-title" className="grid gap-3 p-4 sm:p-6">
        <CardTitle id="knowledge-title">{t('knowledge.title')}</CardTitle>
        <p>{t('knowledge.intro')}</p>
        {items.isPending && <p role="status">{t('common.loading')}</p>}
        <ErrorNotice error={items.error} />
        {items.data?.items.length === 0 && <p>{t('knowledge.empty')}</p>}
        <ul className="grid gap-1">
          {items.data?.items.map((entry) => (
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
      </Card>

      <ErrorNotice error={selected.error} />
      {selected.data && (
        <ItemEditor
          key={selected.data.item.id}
          item={selected.data.item}
          mayWrite={mayWrite}
          onChanged={refresh}
          onClose={close}
        />
      )}

      {mayWrite && (
        <Card role="region" aria-labelledby="knowledge-new-title" className="grid gap-3 p-4 sm:p-6">
          <CardTitle id="knowledge-new-title">{t('knowledge.add')}</CardTitle>
          <form onSubmit={submitNew} className="grid gap-4">
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
            <Button type="submit" disabled={create.isPending} className="justify-self-start">
              {create.isPending ? t('common.working') : t('knowledge.add')}
            </Button>
          </form>
        </Card>
      )}
    </>
  );
}
