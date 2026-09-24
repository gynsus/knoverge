import type { ProposalDetail as Proposal } from '@knoverge/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AlertTriangle, Check, Clock, Pencil, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ChipInput } from '@/components/ui/chip-input';
import { Field, FieldSet } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { relativeTime } from '@/lib/relative-time';
import { adminApi } from '../../api/admin.ts';
import { ErrorNotice } from '../ErrorNotice.tsx';
import { Markdown } from '../knowledge/Markdown.tsx';
import { Diff, ListDiff } from './Diff.tsx';
import { RejectDialog } from './RejectDialog.tsx';
import { contentOf, queueReasons, ruledOutDuplicates, type Content } from './proposal.ts';

/**
 * One proposal, and the decision to be made about it.
 *
 * Read first, edit second. The panel opens showing what was proposed, why it
 * is waiting and what it would change; the form appears only when somebody
 * says they want to change it before approving. A panel that opens as five
 * input boxes has answered "how do I edit this record" — which is not the
 * question a reviewer arrived with.
 */
export function ProposalDetail({
  proposal,
  proposer,
  onResolved,
}: {
  proposal: Proposal;
  proposer: string;
  onResolved: () => Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const content = contentOf(proposal);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Content | null>(content);
  const [note, setNote] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), [proposal.id]);

  // Only what the reviewer actually changed, and only among the fields the
  // proposal carried: sending back an untouched field as an edit would record
  // approved_with_edits for a reviewer who edited nothing.
  const edits = {
    ...(draft?.title !== undefined && draft.title !== content?.title ? { title: draft.title } : {}),
    ...(draft?.body !== undefined && draft.body !== content?.body ? { body: draft.body } : {}),
    ...(draft?.categories !== undefined &&
    draft.categories.join('\u0000') !== (content?.categories ?? []).join('\u0000')
      ? { categories: draft.categories }
      : {}),
    ...(draft?.tags !== undefined &&
    draft.tags.join('\u0000') !== (content?.tags ?? []).join('\u0000')
      ? { tags: draft.tags }
      : {}),
  };
  const edited = Object.keys(edits).length > 0;

  const approve = useMutation({
    mutationFn: () =>
      adminApi.proposals.approve({
        proposal_id: proposal.id,
        ...(edited ? { edits } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      }),
    onSuccess: onResolved,
  });
  const reject = useMutation({
    mutationFn: (reason: string) =>
      adminApi.proposals.reject({
        proposal_id: proposal.id,
        ...(reason ? { reason } : {}),
      }),
    onSuccess: async () => {
      setRejecting(false);
      await onResolved();
    },
  });

  const busy = approve.isPending || reject.isPending;
  const sources = content?.sources ?? [];
  const ruledOut = ruledOutDuplicates(proposal);

  return (
    // Named by its own heading, so a reviewer moving through the queue with a
    // screen reader is told which proposal they have landed on.
    <div role="region" aria-labelledby="review-detail-title" className="grid content-start gap-6">
      <header className="grid gap-2">
        <h3
          id="review-detail-title"
          ref={heading}
          tabIndex={-1}
          className="text-xl font-semibold tracking-tight focus-visible:outline-none"
        >
          {proposal.title ?? t(`review.types.${proposal.proposal_type}`)}
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="font-normal">
            {t(`review.types.${proposal.proposal_type}`)}
          </Badge>
          <Badge variant={proposal.status === 'conflict' ? 'destructive' : 'default'}>
            {t(`review.statuses.${proposal.status}`)}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          {t('review.proposed_by', { name: proposer })} ·{' '}
          <time
            dateTime={proposal.created_at}
            title={new Date(proposal.created_at).toLocaleString(i18n.language)}
          >
            {relativeTime(proposal.created_at, i18n.language)}
          </time>
        </p>
      </header>

      {/* Why this is here at all. Without it a reviewer is deciding without
          the one fact that frames the decision. */}
      <section className="grid gap-2 rounded-lg border border-border bg-muted/40 p-4">
        <h4 className="flex items-center gap-2 text-sm font-medium">
          <AlertTriangle aria-hidden="true" className="size-4 text-muted-foreground" />
          {t('review.queue_reason')}
        </h4>
        <ul className="grid gap-1 text-sm text-muted-foreground">
          {queueReasons(proposal).map((reason) => (
            <li key={reason}>{t(`review.queue_reasons.${reason}`)}</li>
          ))}
        </ul>
      </section>

      <section className="grid gap-3">
        <h4 className="text-sm font-medium">{t('review.context')}</h4>
        <dl className="grid gap-2 text-sm sm:grid-cols-[10rem_1fr]">
          <dt className="text-muted-foreground">{t('review.lands_in')}</dt>
          <dd>{content?.categories?.join(', ') || t('review.no_category')}</dd>
          {content?.type && (
            <>
              <dt className="text-muted-foreground">{t('knowledge.type')}</dt>
              <dd>{t(`knowledge.types.${content.type}`, { defaultValue: content.type })}</dd>
            </>
          )}
          {content?.tags && content.tags.length > 0 && (
            <>
              <dt className="text-muted-foreground">{t('knowledge.tags')}</dt>
              <dd>{content.tags.join(', ')}</dd>
            </>
          )}
          {proposal.target_item_id && (
            <>
              <dt className="text-muted-foreground">
                {proposal.proposal_type === 'knowledge_supersede'
                  ? t('review.replaces')
                  : t('review.changes_item')}
              </dt>
              <dd>
                <TargetItem itemId={proposal.target_item_id} />
              </dd>
            </>
          )}
          {proposal.confidence !== null && (
            <>
              <dt className="text-muted-foreground">{t('review.confidence_label')}</dt>
              <dd>{Math.round(proposal.confidence * 100)}%</dd>
            </>
          )}
        </dl>
        {proposal.reason && (
          <p className="text-sm">
            <span className="text-muted-foreground">{t('review.reason')}: </span>
            {proposal.reason}
          </p>
        )}
        {ruledOut.length > 0 && (
          <p className="text-sm text-muted-foreground">
            {t('review.duplicates_ruled_out', { count: ruledOut.length })}
          </p>
        )}
      </section>

      {editing ? (
        <EditForm
          draft={draft}
          onChange={setDraft}
          note={note}
          onNote={setNote}
          disabled={busy}
          onCancel={() => {
            setDraft(content);
            setEditing(false);
          }}
        />
      ) : (
        <section className="grid gap-3">
          <h4 className="text-sm font-medium">
            {proposal.target_item_id && content?.body !== undefined
              ? t('review.changes')
              : t('review.proposed')}
          </h4>
          {proposal.target_item_id && content?.body !== undefined ? (
            <>
              <Diff itemId={proposal.target_item_id} after={content.body} />
              <MetadataDiff itemId={proposal.target_item_id} content={content} />
            </>
          ) : content?.body !== undefined ? (
            <Markdown>{content.body}</Markdown>
          ) : (
            <p className="text-sm text-muted-foreground">{t('review.no_content')}</p>
          )}
        </section>
      )}

      {/* Provenance is the thing an agent proposal lives or dies on, so its
          absence is stated rather than left as a section that is not there. */}
      <section className="grid gap-2">
        <h4 className="text-sm font-medium">{t('review.sources')}</h4>
        {sources.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('review.no_sources')}</p>
        ) : (
          <ul className="grid gap-1 text-sm">
            {sources.map((source, index) => (
              <li key={index} className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className="font-normal">
                  {source.type}
                </Badge>
                <span className="min-w-0 break-all text-muted-foreground">
                  {[source.client, source.uri, source.external_key, source.session_id]
                    .filter(Boolean)
                    .join(' · ') || t('review.source_unnamed')}
                </span>
                <Badge variant="outline" className="font-normal text-muted-foreground">
                  {t(`knowledge.evidence_roles.${source.role}`, { defaultValue: source.role })}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ErrorNotice error={approve.error} />

      <div className="sticky bottom-0 -mx-4 grid gap-2 border-t border-border bg-background px-4 py-3 sm:-mx-6 sm:px-6">
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={() => approve.mutate()} disabled={busy}>
            <Check aria-hidden="true" className="size-4" />
            {approve.isPending
              ? t('common.working')
              : edited
                ? t('review.approve_with_edits')
                : t('review.approve_as_is')}
          </Button>
          {!editing && (
            <Button
              type="button"
              variant="outline"
              onClick={() => setEditing(true)}
              disabled={busy}
            >
              <Pencil aria-hidden="true" className="size-4" />
              {t('review.edit_first')}
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            onClick={() => setRejecting(true)}
            disabled={busy}
            className="text-destructive"
          >
            <X aria-hidden="true" className="size-4" />
            {t('review.reject')}
          </Button>
          {/* In the plan, not in the product: postponing is a state a
              proposal does not have yet, and inventing one in the browser
              would be a queue only this browser agrees with. */}
          <Button type="button" variant="ghost" disabled title={t('review.postpone_not_yet')}>
            <Clock aria-hidden="true" className="size-4" />
            {t('review.postpone')}
            <Badge variant="outline" className="ml-1 font-normal text-muted-foreground">
              {t('settings.not_yet')}
            </Badge>
          </Button>
        </div>
      </div>

      <RejectDialog
        open={rejecting}
        onOpenChange={setRejecting}
        onReject={(reason) => reject.mutate(reason)}
        busy={reject.isPending}
        error={reject.error}
      />
    </div>
  );
}

/** `ChipInput` holds a comma-separated string; the proposal holds a list. */
function listOf(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/** The item a proposal would change, named rather than left as an id. */
function TargetItem({ itemId }: { itemId: string }) {
  const item = useQuery({
    queryKey: ['knowledge', 'items', itemId],
    queryFn: ({ signal }) => adminApi.knowledge.get(itemId, signal),
  });
  return <span>{item.data?.item.title ?? itemId}</span>;
}

/** What an update would do to the fields that are sets rather than prose. */
function MetadataDiff({ itemId, content }: { itemId: string; content: Content }) {
  const { t } = useTranslation();
  const item = useQuery({
    queryKey: ['knowledge', 'items', itemId],
    queryFn: ({ signal }) => adminApi.knowledge.get(itemId, signal),
  });
  if (!item.data) return null;
  return (
    <div className="grid gap-1">
      {content.categories && (
        <ListDiff
          label={t('knowledge.categories')}
          before={item.data.item.categories}
          after={content.categories}
        />
      )}
      {content.tags && (
        <ListDiff label={t('knowledge.tags')} before={item.data.item.tags} after={content.tags} />
      )}
    </div>
  );
}

/** The fields a reviewer may change before approving, and their note. */
function EditForm({
  draft,
  onChange,
  note,
  onNote,
  disabled,
  onCancel,
}: {
  draft: Content | null;
  onChange: (draft: Content) => void;
  note: string;
  onNote: (note: string) => void;
  disabled: boolean;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  if (!draft) return <p className="text-sm">{t('review.no_content')}</p>;
  return (
    <section className="grid gap-3">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-sm font-medium">{t('review.editing')}</h4>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t('review.stop_editing')}
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">{t('review.edit_hint')}</p>
      <FieldSet disabled={disabled} className="max-w-none">
        {draft.title !== undefined && (
          <Field label={t('knowledge.item_title')}>
            <Input
              value={draft.title}
              onChange={(e) => onChange({ ...draft, title: e.target.value })}
              maxLength={300}
            />
          </Field>
        )}
        {draft.categories !== undefined && (
          <Field label={t('knowledge.categories')} hint={t('knowledge.categories_hint')}>
            <ChipInput
              label={t('knowledge.categories')}
              value={draft.categories.join(', ')}
              onChange={(value) => onChange({ ...draft, categories: listOf(value) })}
            />
          </Field>
        )}
        {draft.tags !== undefined && (
          <Field label={t('knowledge.tags')} hint={t('knowledge.tags_hint')}>
            <ChipInput
              label={t('knowledge.tags')}
              value={draft.tags.join(', ')}
              onChange={(value) => onChange({ ...draft, tags: listOf(value) })}
            />
          </Field>
        )}
        {draft.body !== undefined && (
          <Field label={t('knowledge.body')}>
            <Textarea
              rows={14}
              value={draft.body}
              onChange={(e) => onChange({ ...draft, body: e.target.value })}
            />
          </Field>
        )}
        <Field label={t('review.note')} hint={t('review.note_hint')}>
          <Textarea
            rows={2}
            value={note}
            onChange={(e) => onNote(e.target.value)}
            maxLength={2000}
          />
        </Field>
      </FieldSet>
    </section>
  );
}
