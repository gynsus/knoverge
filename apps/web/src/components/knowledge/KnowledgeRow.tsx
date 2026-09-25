import type { EvidenceState, ItemType, ReviewState } from '@knoverge/contracts';
import { AlertTriangle, Check, FileText, Link2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { relativeTime } from '@/lib/relative-time';

/**
 * One item, as a list of them shows it.
 *
 * The same shape whether the row came from browsing or from a search, because
 * the two answer the same question — which of these do I want to read — and
 * two row designs on one screen is two things to learn.
 */
export interface RowItem {
  id: string;
  title: string;
  type: ItemType;
  categories: string[];
  reviewState: ReviewState;
  evidenceState: EvidenceState;
  disputed: boolean;
  updatedAt: string;
  /** How many times it has been written. A ledger's rows say. */
  revisionNumber?: number | undefined;
  /** Present on a search result: the passage that answered. */
  snippet?: string | undefined;
}

/** `architecture/constraints` reads as `architecture / constraints`. */
function breadcrumb(path: string): string {
  return path.split('/').join(' / ');
}

/**
 * The file path is deliberately absent.
 *
 * It was the widest thing in every row and the least useful: at seventy items
 * it was most of what the eye had to skip past to reach the titles. It belongs
 * where somebody asks for it, which is the drawer.
 */
export function KnowledgeRow({
  item,
  onOpen,
  atCursor = false,
}: {
  item: RowItem;
  onOpen: () => void;
  /** Where the arrow keys are. Marked, or they move nothing anybody can see. */
  atCursor?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const reviewed = item.reviewState !== 'unreviewed';
  const sourced = item.evidenceState !== 'none';

  return (
    <li
      ref={(node) => {
        // Brought into view as the arrows move, or the cursor walks off the
        // bottom of a long list and nothing appears to happen.
        if (atCursor) node?.scrollIntoView({ block: 'nearest' });
      }}
      aria-current={atCursor ? 'true' : undefined}
      className={cn(
        'group relative border-b border-border transition-colors last:border-0',
        // The row is the control — the title stretches a button over all of
        // it — so the whole row answers the pointer. Without that a list of
        // fifty gives no sign that any of it can be pressed.
        atCursor ? 'bg-accent' : 'hover:bg-muted/60',
      )}
    >
      <div className="grid gap-1 px-2 py-3">
        <div className="flex items-start justify-between gap-3">
          <button
            type="button"
            onClick={onOpen}
            className="text-left font-medium after:absolute after:inset-0 after:content-[''] focus-visible:outline-none group-focus-within:underline"
          >
            {item.title}
          </button>
          <Badge variant="outline" className="shrink-0">
            {t(`knowledge.types.${item.type}`)}
          </Badge>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span className="truncate">
            {item.categories[0] === undefined
              ? t('knowledge.uncategorised')
              : breadcrumb(item.categories[0])}
          </span>
          <span className="flex items-center gap-1">
            {reviewed ? (
              <Check aria-hidden="true" className="size-3.5" />
            ) : (
              <FileText aria-hidden="true" className="size-3.5" />
            )}
            {t(`knowledge.review.${item.reviewState}`)}
          </span>
          <span className="flex items-center gap-1">
            <Link2 aria-hidden="true" className="size-3.5" />
            {sourced ? t('knowledge.sourced') : t('knowledge.unsourced')}
          </span>
          {item.disputed && (
            <span className="flex items-center gap-1 text-destructive">
              <AlertTriangle aria-hidden="true" className="size-3.5" />
              {t('knowledge.disputed')}
            </span>
          )}
          <span className="ml-auto shrink-0">
            {t('knowledge.updated_when', {
              when: relativeTime(item.updatedAt, i18n.language),
            })}
            {item.revisionNumber !== undefined &&
              ` · ${t('knowledge.revision', { number: item.revisionNumber })}`}
          </span>
        </div>

        {/* Why this row answered, when a search is what produced it. The
            passage is far more use than the title alone: two items can share
            a title and differ entirely in what they say. */}
        {item.snippet && (
          <p className="line-clamp-2 text-sm text-muted-foreground">{item.snippet}</p>
        )}
      </div>
    </li>
  );
}
