import type { ProposalDetail, ProposalSummary } from '@knoverge/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { Field, FieldSet } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { adminApi } from '../api/admin.ts';
import { ErrorNotice } from '../components/ErrorNotice.tsx';

const INBOX_KEY = ['proposals', 'pending'] as const;

/** The fields of a create or supersede payload a reviewer can read and change. */
interface Content {
  title: string;
  body: string;
  categories: string[];
  tags: string[];
}

/**
 * What the proposal asks for, whichever kind it is.
 *
 * A create carries the content at the top level; a supersession carries it
 * under `new_item`, or carries nothing when the replacement is an item the
 * workspace already holds; an update carries only the fields it changes; a
 * delete carries nothing at all.
 */
function contentOf(proposal: ProposalDetail): Content | null {
  const payload = proposal.proposed_payload as Record<string, unknown> | null;
  if (!payload) return null;
  const source = (
    proposal.proposal_type === 'knowledge_supersede'
      ? (payload['newItem'] as Record<string, unknown> | undefined)
      : payload
  ) as Record<string, unknown> | undefined;
  if (!source) return null;
  const text = (key: string): string => (typeof source[key] === 'string' ? source[key] : '');
  const list = (key: string): string[] =>
    Array.isArray(source[key]) ? (source[key] as string[]) : [];
  if (proposal.proposal_type === 'knowledge_delete') return null;
  return {
    title: text('title'),
    body: text('body'),
    categories: list('categories'),
    tags: list('tags'),
  };
}

/** Line-by-line, which is what a person reads a change as. */
function diffLines(before: string, after: string): { mark: ' ' | '-' | '+'; text: string }[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const common = new Set(b);
  const kept = new Set(a.filter((line) => common.has(line)));
  const rows: { mark: ' ' | '-' | '+'; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const left = a[i];
    const right = b[j];
    if (i < a.length && j < b.length && left === right) {
      rows.push({ mark: ' ', text: left as string });
      i += 1;
      j += 1;
    } else if (i < a.length && !kept.has(left as string)) {
      rows.push({ mark: '-', text: left as string });
      i += 1;
    } else if (j < b.length) {
      rows.push({ mark: '+', text: right as string });
      j += 1;
    } else {
      rows.push({ mark: '-', text: left as string });
      i += 1;
    }
  }
  return rows;
}

/**
 * What an update proposal would change, against what the item says now.
 *
 * Approving without seeing this is approving a diff nobody read, which is the
 * one thing a review is for.
 */
function Diff({ itemId, after }: { itemId: string; after: string }) {
  const { t } = useTranslation();
  const item = useQuery({
    queryKey: ['knowledge', 'items', itemId],
    queryFn: ({ signal }) => adminApi.knowledge.get(itemId, signal),
  });
  if (item.isPending) return <p role="status">{t('common.loading')}</p>;
  if (item.error) return <ErrorNotice error={item.error} />;
  const before = item.data?.item.body ?? '';
  const rows = diffLines(before.trimEnd(), after.trimEnd());
  return (
    <pre className="overflow-x-auto rounded-md border bg-muted/40 p-3 text-xs leading-relaxed">
      {rows.map((row, index) => (
        <div
          key={`${index}-${row.text}`}
          className={
            row.mark === '+'
              ? 'text-emerald-700 dark:text-emerald-400'
              : row.mark === '-'
                ? 'text-rose-700 dark:text-rose-400'
                : 'text-muted-foreground'
          }
        >
          {row.mark} {row.text || ' '}
        </div>
      ))}
    </pre>
  );
}

/**
 * One proposal, and the two decisions a reviewer can make about it.
 *
 * Its own component keyed by the proposal id, so the draft starts from the
 * proposal it was given rather than being synchronised from an effect.
 */
function ProposalReview({
  proposal,
  onResolved,
  onClose,
}: {
  proposal: ProposalDetail;
  onResolved: () => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const content = contentOf(proposal);
  const [draft, setDraft] = useState<Content | null>(content);
  const [note, setNote] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);

  const edited =
    content !== null &&
    draft !== null &&
    (draft.title !== content.title || draft.body !== content.body);

  const approve = useMutation({
    mutationFn: () =>
      adminApi.proposals.approve({
        proposal_id: proposal.id,
        ...(edited && draft ? { edits: { title: draft.title, body: draft.body } } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      }),
    onSuccess: onResolved,
  });
  const reject = useMutation({
    mutationFn: () =>
      adminApi.proposals.reject({
        proposal_id: proposal.id,
        ...(note.trim() ? { reason: note.trim() } : {}),
      }),
    onSuccess: onResolved,
  });

  return (
    <Card role="region" aria-labelledby="review-detail-title" className="grid gap-3 p-4 sm:p-6">
      <CardTitle id="review-detail-title" tabIndex={-1} ref={heading}>
        {content?.title || t(`review.types.${proposal.proposal_type}`)}
      </CardTitle>
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <Badge>{t(`review.types.${proposal.proposal_type}`)}</Badge>
        <Badge>{t(`review.statuses.${proposal.status}`)}</Badge>
        <small>{new Date(proposal.created_at).toLocaleString()}</small>
      </p>
      {proposal.reason && (
        <p className="text-sm">
          <strong>{t('review.reason')}:</strong> {proposal.reason}
        </p>
      )}
      {proposal.confidence !== null && (
        <p className="text-sm text-muted-foreground">
          {t('review.confidence', { value: Math.round(proposal.confidence * 100) })}
        </p>
      )}

      {proposal.target_item_id && content && (
        <>
          <h3 className="mt-2 text-base font-semibold">{t('review.changes')}</h3>
          <Diff itemId={proposal.target_item_id} after={content.body} />
        </>
      )}

      {draft ? (
        <FieldSet disabled={approve.isPending || reject.isPending}>
          <Field label={t('knowledge.item_title')}>
            <Input
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              maxLength={300}
            />
          </Field>
          <Field label={t('knowledge.body')} hint={t('review.edit_hint')}>
            <Textarea
              rows={12}
              value={draft.body}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            />
          </Field>
        </FieldSet>
      ) : (
        <p className="text-sm">{t('review.no_content')}</p>
      )}

      <Field label={t('review.note')} hint={t('review.note_hint')}>
        <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
      </Field>

      <ErrorNotice error={approve.error ?? reject.error} />
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={() => approve.mutate()} disabled={approve.isPending}>
          {approve.isPending
            ? t('common.working')
            : edited
              ? t('review.approve_with_edits')
              : t('review.approve')}
        </Button>
        <Button
          variant="destructive"
          type="button"
          onClick={() => reject.mutate()}
          disabled={reject.isPending}
        >
          {t('review.reject')}
        </Button>
        <Button variant="outline" type="button" onClick={onClose}>
          {t('common.close')}
        </Button>
      </div>
    </Card>
  );
}

/**
 * The review inbox.
 *
 * A queue, oldest first: what has been waiting longest is what to look at.
 * Rule 14 sends every agent write here unless a policy rule says otherwise,
 * so this is where an agent's contributions become the workspace's knowledge.
 */
export function ReviewPage() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const lastTrigger = useRef<HTMLElement | null>(null);

  const inbox = useQuery({
    queryKey: INBOX_KEY,
    queryFn: ({ signal }) => adminApi.proposals.list('pending', signal),
  });
  const selected = useQuery({
    queryKey: [...INBOX_KEY, selectedId],
    queryFn: ({ signal }) => adminApi.proposals.get(selectedId as string, signal),
    enabled: selectedId !== null,
  });

  const resolved = async () => {
    setSelectedId(null);
    await client.invalidateQueries({ queryKey: ['proposals'] });
    await client.invalidateQueries({ queryKey: ['knowledge'] });
    lastTrigger.current?.focus();
  };

  return (
    <>
      <Card aria-labelledby="review-title" className="grid gap-3 p-4 sm:p-6">
        <CardTitle id="review-title">{t('review.title')}</CardTitle>
        <p>{t('review.intro')}</p>
        {inbox.isPending && <p role="status">{t('common.loading')}</p>}
        <ErrorNotice error={inbox.error} />
        {inbox.data?.proposals.length === 0 && <p>{t('review.empty')}</p>}
        <ul className="grid gap-1">
          {inbox.data?.proposals.map((entry: ProposalSummary) => (
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
                {entry.reason || t(`review.types.${entry.proposal_type}`)}
              </Button>
              <Badge>{t(`review.types.${entry.proposal_type}`)}</Badge>
              <small className="text-muted-foreground">
                {new Date(entry.created_at).toLocaleString()}
              </small>
            </li>
          ))}
        </ul>
      </Card>

      <ErrorNotice error={selected.error} />
      {selected.data && (
        <ProposalReview
          key={selected.data.proposal.id}
          proposal={selected.data.proposal}
          onResolved={resolved}
          onClose={() => {
            setSelectedId(null);
            lastTrigger.current?.focus();
          }}
        />
      )}
    </>
  );
}
