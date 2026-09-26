import { splitDependencyRef } from '@knoverge/contracts';
import { useQueries } from '@tanstack/react-query';
import { History } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Badge } from '@/components/ui/badge';
import { adminApi } from '../../api/admin.ts';

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
