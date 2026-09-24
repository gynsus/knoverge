import type { ProposalSummary } from '@knoverge/contracts';
import { useTranslation } from 'react-i18next';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { relativeTime } from '@/lib/relative-time';

/**
 * One proposal in the queue.
 *
 * Dense on purpose: a reviewer facing ninety of these is scanning, and the
 * four things they scan for are what it is, who proposed it, where it would
 * land and how long it has been waiting. The title alone — which is what this
 * list used to show — answers none of them.
 */
export function QueueItem({
  proposal,
  proposer,
  selected,
  seen,
  onSelect,
}: {
  proposal: ProposalSummary;
  proposer: string;
  selected: boolean;
  /** Whether this one has been opened in this session. */
  seen: boolean;
  onSelect: () => void;
}) {
  const { t, i18n } = useTranslation();
  const conflict = proposal.status === 'conflict';
  // Where it would land, when the proposal says. An update that leaves the
  // categories alone names none, and inventing "no category" for it would be
  // a statement the proposal never made — but a new item that names none
  // really is uncategorised, and that is worth seeing from the queue.
  const where =
    proposal.categories.length > 0
      ? proposal.categories.join(', ')
      : proposal.proposal_type === 'knowledge_create'
        ? t('review.no_category_short')
        : null;

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'grid w-full gap-1 border-l-2 px-3 py-2.5 text-left transition-colors',
        'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
        selected ? 'border-l-primary bg-accent' : 'border-l-transparent hover:bg-muted/60',
      )}
    >
      <span className="flex items-start gap-2">
        {/* Unread, read: a mark rather than bold text, so the title's own
            weight still means "this is the title". */}
        <span
          aria-hidden="true"
          className={cn(
            'mt-1.5 size-2 shrink-0 rounded-full',
            conflict ? 'bg-destructive' : seen ? 'bg-transparent ring-1 ring-border' : 'bg-primary',
          )}
        />
        <span className="min-w-0 flex-1 text-sm leading-5 font-medium break-words">
          {proposal.title ?? t(`review.types.${proposal.proposal_type}`)}
        </span>
      </span>
      <span className="flex flex-wrap items-center gap-1.5 pl-4">
        <Badge variant="outline" className="font-normal">
          {t(`review.types.${proposal.proposal_type}`)}
        </Badge>
        {conflict && <Badge variant="destructive">{t('review.statuses.conflict')}</Badge>}
        <span className="truncate text-xs text-muted-foreground">{proposer}</span>
      </span>
      <span className="flex flex-wrap items-center gap-x-2 pl-4 text-xs text-muted-foreground">
        {where !== null && (
          <>
            <span className="truncate">{where}</span>
            <span aria-hidden="true">·</span>
          </>
        )}
        <span>{relativeTime(proposal.created_at, i18n.language)}</span>
      </span>
    </button>
  );
}
