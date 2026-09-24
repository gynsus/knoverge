import type { KnowledgeCounts } from '@knoverge/contracts';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { VIEWS, type View } from './views.ts';

/**
 * The list as a small inbox.
 *
 * A number beside a name turns "narrow this list" into "there are thirty-one
 * of these", which is the question somebody actually has. The counts are over
 * the whole workspace rather than the page that happens to be loaded, and each
 * one counts exactly what its view filters to: a count that does not match the
 * list it opens is read as a fact and is wrong.
 */
export function QuickViews({
  counts,
  current,
  onChoose,
}: {
  /** Null while they are still being counted; the names still work. */
  counts: KnowledgeCounts | null;
  current: View;
  onChoose: (view: View) => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-wrap gap-2">
      {VIEWS.map((view) => {
        const size = counts ? counts[view === 'all' ? 'total' : view] : null;
        const pressing = view === current;
        return (
          <button
            key={view}
            type="button"
            onClick={() => onChoose(view)}
            aria-pressed={pressing}
            className={cn(
              'flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm transition-colors',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
              pressing
                ? 'border-primary bg-primary/10 font-medium text-foreground'
                : 'border-border text-muted-foreground hover:bg-muted',
            )}
          >
            {t(`knowledge.views.${view}`)}
            {size !== null && (
              <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                {size}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
