import { splitDependencyRef } from '@knoverge/contracts';
import { useMutation, useQueries } from '@tanstack/react-query';
import { History, Loader2, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { adminApi } from '../../api/admin.ts';
import { ErrorNotice } from '../ErrorNotice.tsx';
import { ItemPicker } from './ItemPicker.tsx';

/**
 * What a summary was made from, and which of it has moved on.
 *
 * The list alone would be a set of ids. The useful question is narrower: which
 * of these have changed since the summary read them, because those are the ones
 * somebody has to look at. A summary is stale when any one of them has
 * (ADR 0024), and this says which.
 */
export function SummaryOf({
  refs,
  onOpen,
}: {
  /** `<item id>@<revision id>`, the way the file carries them. */
  refs: readonly string[];
  onOpen: (itemId: string) => void;
}) {
  const { t } = useTranslation();
  const pairs = refs.map((ref) => splitDependencyRef(ref));
  const answers = useQueries({
    queries: pairs.map((pair) => ({
      queryKey: ['knowledge', 'items', pair.itemId],
      queryFn: ({ signal }: { signal: AbortSignal }) => adminApi.knowledge.get(pair.itemId, signal),
    })),
  });

  if (refs.length === 0) return null;
  return (
    <section className="grid gap-2">
      <h4 className="text-sm font-medium">{t('knowledge.summary_of')}</h4>
      <ul className="grid gap-1.5 text-sm">
        {pairs.map((pair, index) => {
          const source = answers[index]?.data?.item;
          // Undecided while it loads: saying "unchanged" before the answer
          // arrives is a claim, and a wrong one half the time.
          const moved = source ? source.current_revision_id !== pair.revisionId : null;
          return (
            <li key={pair.itemId} className="flex flex-wrap items-baseline gap-2">
              <button
                type="button"
                onClick={() => onOpen(pair.itemId)}
                className="min-w-0 truncate text-left underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                {source?.title ?? pair.itemId}
              </button>
              {moved === true && (
                <Badge variant="outline" className="gap-1 font-normal">
                  <History aria-hidden="true" className="size-3" />
                  {t('knowledge.source_moved')}
                </Badge>
              )}
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-muted-foreground">{t('knowledge.summary_of_hint')}</p>
    </section>
  );
}

/**
 * Choosing what a summary is made from, and asking a model for a first draft.
 *
 * The refs carry a revision and a picker only knows an item, so choosing a
 * source reads which revision it is at now. Drafting replaces both the sources
 * and the text, because a draft is made from what is current by definition —
 * which is also what makes the summary that follows not stale (ADR 0024).
 *
 * The draft is never saved here. It fills the form, and the person saves it
 * through the same write as anything else, which is where provenance, review and
 * Git live.
 */
export function SummaryOfEditor({
  refs,
  selfId,
  onChange,
  onDrafted,
}: {
  refs: readonly string[];
  /** This summary, which may not be one of its own sources. */
  selfId: string;
  onChange: (refs: string[]) => void;
  /** The drafted text, for the caller to put in the body. */
  onDrafted: (body: string) => void;
}) {
  const { t } = useTranslation();
  const pairs = refs.map((ref) => splitDependencyRef(ref));
  /** What the picker is showing while a choice is being read. */
  const [picking, setPicking] = useState<{ id: string; title: string | null }>({
    id: '',
    title: null,
  });
  const titles = useQueries({
    queries: pairs.map((pair) => ({
      queryKey: ['knowledge', 'items', pair.itemId],
      queryFn: ({ signal }: { signal: AbortSignal }) => adminApi.knowledge.get(pair.itemId, signal),
    })),
  });

  const add = useMutation({
    mutationFn: (itemId: string) => adminApi.knowledge.get(itemId),
    onSuccess: (answer) => {
      // The revision it is at now: the ref is the claim "as it read here", and
      // guessing which revision that was is not something a form may do.
      const ref = `${answer.item.id}@${answer.item.current_revision_id}`;
      if (!refs.includes(ref)) onChange([...refs, ref]);
      // Back to empty: the choice is in the list above now, and a picker still
      // showing it would read as a second one about to be added.
      setPicking({ id: '', title: null });
    },
  });

  const write = useMutation({
    mutationFn: () =>
      adminApi.knowledge.draftSummary({
        item_ids: pairs.map((pair) => pair.itemId) as never,
      }),
    onSuccess: (answer) => {
      onChange([...answer.summary_of]);
      onDrafted(answer.body);
    },
  });

  return (
    <Field label={t('knowledge.summary_of')} hint={t('knowledge.summary_of_edit_hint')}>
      <div className="grid gap-2">
        {pairs.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('knowledge.summary_of_none')}</p>
        ) : (
          <ul className="grid gap-1.5 text-sm">
            {pairs.map((pair, index) => (
              <li key={pair.itemId} className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate">
                  {titles[index]?.data?.item.title ?? pair.itemId}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-destructive"
                  aria-label={t('knowledge.summary_of_remove', {
                    what: titles[index]?.data?.item.title ?? pair.itemId,
                  })}
                  onClick={() => onChange(refs.filter((_, i) => i !== index))}
                >
                  <Trash2 aria-hidden="true" className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}

        <ItemPicker
          value={picking.id}
          title={picking.title}
          label={t('knowledge.summary_of_add')}
          onChange={(id, title) => {
            // Nothing summarises itself: the statement is empty, and it would
            // render as an item listing the page it is on.
            if (id === selfId) return;
            setPicking({ id, title });
            add.mutate(id);
          }}
        />

        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pairs.length === 0 || write.isPending}
            onClick={() => write.mutate()}
          >
            {write.isPending && <Loader2 aria-hidden="true" className="size-4 animate-spin" />}
            {t('knowledge.summary_draft')}
          </Button>
          {write.data?.truncated && (
            <p role="status" className="text-sm text-muted-foreground">
              {t('knowledge.summary_draft_truncated')}
            </p>
          )}
          {write.data && !write.data.truncated && (
            <p role="status" className="text-sm text-muted-foreground">
              {t('knowledge.summary_drafted', { model: write.data.model })}
            </p>
          )}
        </div>
        <ErrorNotice error={add.error ?? write.error} />
      </div>
    </Field>
  );
}
