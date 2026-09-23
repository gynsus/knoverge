import type { EvidenceState, ItemType, ReviewState } from '@knoverge/contracts';
import { AlertTriangle, Check, FileText, Link2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Badge } from '@/components/ui/badge';
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
  /** Present on a search result: the text that matched, already highlighted. */
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
export function KnowledgeRow({ item, onOpen }: { item: RowItem; onOpen: () => void }) {
  const { t, i18n } = useTranslation();
  const reviewed = item.reviewState !== 'unreviewed';
  const sourced = item.evidenceState !== 'none';

  return (
    <li className="group relative border-b border-border last:border-0">
      <div className="grid gap-1 py-3">
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
          </span>
        </div>
      </div>
    </li>
  );
}
