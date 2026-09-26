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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Markdown } from './Markdown.tsx';
import { RevisionDiff } from './RevisionDiff.tsx';
import { DisputedBy, RelationList } from './RelationList.tsx';
import { Validity } from './Validity.tsx';
import { SourceList } from './SourceList.tsx';

/** Which of the three references was copied. */
type CopyKind = 'link' | 'id' | 'path';

/** How long a tick means "just now" before it becomes part of the menu. */
const COPY_SHOWS_FOR_MS = 2000;

function CopyIcon({ done }: { done: boolean }) {
  return done ? (
    <Check aria-hidden="true" className="size-4" />
  ) : (
    <Copy aria-hidden="true" className="size-4" />
  );
}

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
  onOpenItem,
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
  /** Opens another item, for following a relation. */
  onOpenItem: (itemId: string) => void;
  busy: boolean;
  error: unknown;
}) {
  const { t, i18n } = useTranslation();
  /**
   * Which of the three copies last succeeded, or `refused` when the browser
   * would not give up the clipboard.
   *
   * One value rather than a flag per item: three ticks that can all be lit at
   * once say nothing about which one was pressed.
   */
  const [copied, setCopied] = useState<CopyKind | 'refused' | null>(null);
  const [confirming, setConfirming] = useState(false);

  const copy = (kind: CopyKind, text: string) => {
    void copyToClipboard(text).then((ok) => {
      setCopied(ok ? kind : 'refused');
      // The tick means "just now". Left lit it becomes part of the menu.
      setTimeout(() => setCopied(null), COPY_SHOWS_FOR_MS);
    });
  };

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
              {/* Three ways to refer to one item, and they are for three
                  different readers: a person, an agent, and Git. */}
              <DropdownMenuItem
                onSelect={() =>
                  // The address this browser is at. A link is only ever as
                  // good as the address the person following it can reach,
                  // and this is the one that is known to work for at least
                  // the person copying it.
                  copy('link', `${window.location.origin}/knowledge?item=${item.id}`)
                }
              >
                <CopyIcon done={copied === 'link'} />
                {t('knowledge.copy_link')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => copy('id', item.id)}>
                <CopyIcon done={copied === 'id'} />
                {t('knowledge.copy_id')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => copy('path', item.markdown_path)}>
                <CopyIcon done={copied === 'path'} />
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

      {/* The helper says failure is ordinary — a browser may simply refuse
          the clipboard outside a secure context — so it is said rather than
          left as a menu item that appears to do nothing. */}
      {copied === 'refused' && (
        <p role="status" className="text-sm text-destructive">
          {t('knowledge.copy_refused')}
        </p>
      )}
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

      <Tabs defaultValue="content">
        <TabsList>
          <TabsTrigger value="content">{t('knowledge.tab_content')}</TabsTrigger>
          <TabsTrigger value="history">
            {t('knowledge.tab_history')}
            {revisions.data && (
              <span className="ml-1.5 font-mono text-xs text-muted-foreground">
                {revisions.data.revisions.length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="relations">
            {t('knowledge.tab_relations')}
            {item.relations.length + item.disputed_by.length > 0 && (
              <span className="ml-1.5 font-mono text-xs text-muted-foreground">
                {item.relations.length + item.disputed_by.length}
              </span>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="content">
          <article>
            <Markdown>{item.body}</Markdown>
          </article>

          <Separator />

          <section className="grid gap-2 text-sm">
            <h4 className="font-medium">{t('knowledge.about')}</h4>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-muted-foreground">
              <dt>{t('knowledge.categories')}</dt>
              <dd className="text-foreground">
                {item.categories.length > 0
                  ? item.categories.join(', ')
                  : t('knowledge.uncategorised')}
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
              {/* What an agent calls this item, and what `knowledge_get`
                  takes. Nothing else on the screen says it. */}
              <dt>{t('knowledge.identifier')}</dt>
              <dd className="font-mono text-xs break-all text-foreground">{item.id}</dd>
              <dt>{t('knowledge.file')}</dt>
              <dd className="font-mono text-xs break-all text-foreground">{item.markdown_path}</dd>
              {/* Stated even when open-ended, because "always" is an answer and
                  a blank row is not. A claim whose period has passed is still
                  active and still true of the period it names, so it says that
                  rather than disappearing (`KNOWLEDGE_MODEL.md` section 10). */}
              <dt>{t('knowledge.holds')}</dt>
              <dd className="text-foreground">
                <Validity item={item} />
              </dd>
              {item.observed_at && (
                <>
                  <dt>{t('knowledge.observed_at')}</dt>
                  <dd className="text-foreground">
                    {new Date(item.observed_at).toLocaleDateString(i18n.language)}
                  </dd>
                </>
              )}
            </dl>
          </section>

          <Separator />

          {/* Sources are here rather than in a tab of their own: they are
              part of reading the item, not a separate question about it. */}
          <section className="grid gap-2">
            <h4 className="text-sm font-medium">{t('knowledge.sources')}</h4>
            <SourceList sources={item.sources} />
          </section>
        </TabsContent>

        <TabsContent value="history">
          <ErrorNotice error={revisions.error} />
          <History itemId={item.id} revisions={revisions.data?.revisions ?? []} nameOf={nameOf} />
        </TabsContent>

        <TabsContent value="relations">
          <div className="grid gap-3">
            <DisputedBy itemIds={item.disputed_by} onOpen={onOpenItem} />
            <RelationList relations={item.relations} onOpen={onOpenItem} />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

/**
 * Every revision, and what each one changed.
 *
 * The change is not fetched until somebody asks for it: a history of forty
 * revisions would be forty diffs nobody read, each one two files out of Git.
 */
function History({
  itemId,
  revisions,
  nameOf,
}: {
  itemId: string;
  revisions: readonly RevisionSummary[];
  nameOf: Map<string, string>;
}) {
  const { t, i18n } = useTranslation();
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());

  return (
    <ul className="grid gap-4 text-sm">
      {revisions.map((revision, index) => {
        // The one before it in the list, which is ordered newest first.
        const previous = revisions[index + 1];
        const showing = opened.has(revision.id);
        return (
          <li key={revision.id} className="grid gap-1">
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
            {/* The only thing that says why. The history already says who and
                when without it. */}
            {revision.reason !== null && <span>{revision.reason}</span>}
            {previous && (
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto w-fit p-0 text-xs"
                aria-expanded={showing}
                onClick={() =>
                  setOpened((current) => {
                    const next = new Set(current);
                    if (showing) next.delete(revision.id);
                    else next.add(revision.id);
                    return next;
                  })
                }
              >
                {showing ? t('knowledge.hide_changes') : t('knowledge.show_changes')}
              </Button>
            )}
            {showing && previous && (
              <RevisionDiff itemId={itemId} from={previous.id} to={revision.id} />
            )}
          </li>
        );
      })}
    </ul>
  );
}
