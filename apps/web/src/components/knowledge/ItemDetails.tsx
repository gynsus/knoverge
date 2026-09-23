import type { ActorSummary, KnowledgeItemDetail, RevisionSummary } from '@knoverge/contracts';
import { useQuery } from '@tanstack/react-query';
import { Check, Copy, MoreHorizontal, Pencil, RotateCcw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Separator } from '@/components/ui/separator';
import { copyToClipboard } from '@/lib/password';
import { relativeTime } from '@/lib/relative-time';
import { adminApi } from '../../api/admin.ts';
import { ErrorNotice } from '../ErrorNotice.tsx';

/**
 * One item, read rather than edited.
 *
 * Opening a knowledge item used to put a form on the screen, which answers
 * "which fields may I change?" when the question was "what does this say?".
 * For a ledger where every change is a revision and a commit, changing has to
 * be something somebody chose to do.
 */
export function ItemDetails({
  item,
  truncated,
  mayWrite,
  actors,
  onEdit,
  onDelete,
  onRestore,
  busy,
  error,
}: {
  item: KnowledgeItemDetail;
  truncated: boolean;
  mayWrite: boolean;
  actors: readonly ActorSummary[];
  onEdit: () => void;
  onDelete: () => void;
  onRestore: () => void;
  busy: boolean;
  error: unknown;
}) {
  const { t, i18n } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const revisions = useQuery({
    queryKey: ['knowledge', 'items', item.id, 'revisions'],
    queryFn: ({ signal }) => adminApi.knowledge.revisions(item.id, signal),
  });
  const nameOf = new Map(actors.map((a) => [a.id as string, a.display_name]));

  return (
    <div className="grid content-start gap-5 p-4 sm:p-6">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{t(`knowledge.types.${item.type}`)}</Badge>
        <Badge variant="outline">{t(`knowledge.review.${item.review_state}`)}</Badge>
        <Badge variant="outline">{t(`knowledge.evidence.${item.evidence_state}`)}</Badge>
        {item.status !== 'active' && <Badge>{t(`knowledge.statuses.${item.status}`)}</Badge>}
        <span className="text-xs text-muted-foreground">
          {t('knowledge.revision', { number: item.revision_number })}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {mayWrite && item.status !== 'deleted' && !truncated && (
            <Button type="button" size="sm" onClick={onEdit}>
              <Pencil aria-hidden="true" className="size-4" />
              {t('knowledge.edit')}
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="px-2"
                aria-label={t('knowledge.actions')}
              >
                <MoreHorizontal aria-hidden="true" className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onSelect={() => {
                  void copyToClipboard(item.markdown_path).then(setCopied);
                }}
              >
                {copied ? (
                  <Check aria-hidden="true" className="size-4" />
                ) : (
                  <Copy aria-hidden="true" className="size-4" />
                )}
                {t('knowledge.copy_path')}
              </DropdownMenuItem>
              {mayWrite && item.status === 'deleted' && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={onRestore}>
                    <RotateCcw aria-hidden="true" className="size-4" />
                    {t('knowledge.restore')}
                  </DropdownMenuItem>
                </>
              )}
              {mayWrite && item.status !== 'deleted' && (
                <>
                  <DropdownMenuSeparator />
                  {/* Away from Save, which it used to sit beside. A
                      destructive action does not belong among the controls
                      somebody reaches for without looking. */}
                  <DropdownMenuItem
                    onSelect={() => setConfirming(true)}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2 aria-hidden="true" className="size-4" />
                    {t('knowledge.delete')}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {truncated && <p role="alert">{t('knowledge.truncated')}</p>}
      <ErrorNotice error={error} />

      {confirming && (
        <div className="grid gap-2 rounded-md border border-destructive/40 p-3">
          <p className="text-sm">{t('knowledge.confirm_delete')}</p>
          <p className="text-sm text-muted-foreground">{t('knowledge.delete_hint')}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={busy}
              onClick={onDelete}
            >
              {t('knowledge.delete')}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      )}

      {/* The Markdown is shown as written: paragraphs kept, nothing rendered
          into HTML. A renderer for agent-authored text is a question about
          sanitising, and it deserves its own answer rather than arriving as
          part of a layout change. */}
      <article className="text-sm leading-6 whitespace-pre-wrap">{item.body}</article>

      <Separator />

      <section className="grid gap-2 text-sm">
        <h4 className="font-medium">{t('knowledge.about')}</h4>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-muted-foreground">
          <dt>{t('knowledge.categories')}</dt>
          <dd className="text-foreground">
            {item.categories.length > 0 ? item.categories.join(', ') : t('knowledge.uncategorised')}
          </dd>
          <dt>{t('knowledge.tags')}</dt>
          <dd className="flex flex-wrap gap-1">
            {item.tags.length > 0 ? (
              item.tags.map((tag) => (
                <Badge key={tag} variant="outline" className="font-normal">
                  {tag}
                </Badge>
              ))
            ) : (
              <span>{t('knowledge.no_tags')}</span>
            )}
          </dd>
          <dt>{t('knowledge.file')}</dt>
          <dd className="font-mono text-xs break-all text-foreground">{item.markdown_path}</dd>
        </dl>
      </section>

      <Separator />

      <section className="grid gap-2">
        <h4 className="text-sm font-medium">{t('knowledge.history')}</h4>
        <ErrorNotice error={revisions.error} />
        <ul className="grid gap-3 text-sm">
          {(revisions.data?.revisions ?? []).map((revision: RevisionSummary) => (
            <li key={revision.id} className="grid gap-0.5">
              <span className="flex flex-wrap items-baseline gap-2">
                <strong className="font-medium">
                  {t('knowledge.revision', { number: revision.revision_number })}
                </strong>
                <Badge variant="outline">{t(`knowledge.kinds.${revision.change_kind}`)}</Badge>
              </span>
              <span className="text-xs text-muted-foreground">
                {t('knowledge.revision_by', {
                  name: nameOf.get(revision.actor_id) ?? revision.actor_id,
                  when: relativeTime(revision.created_at, i18n.language),
                })}
                {' · '}
                <code>{revision.git_commit.slice(0, 8)}</code>
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
