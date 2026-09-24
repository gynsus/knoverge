import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { adminApi } from '../../api/admin.ts';
import { diffLines } from './diff-lines.ts';
import { ErrorNotice } from '../ErrorNotice.tsx';

/**
 * What an update proposal would change, against what the item says now.
 *
 * Approving without seeing this is approving a change nobody read, which is
 * the one thing a review is for.
 */
export function Diff({ itemId, after }: { itemId: string; after: string }) {
  const { t } = useTranslation();
  const item = useQuery({
    queryKey: ['knowledge', 'items', itemId],
    queryFn: ({ signal }) => adminApi.knowledge.get(itemId, signal),
  });
  if (item.isPending)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {t('common.loading')}
      </p>
    );
  if (item.error) return <ErrorNotice error={item.error} />;
  const before = item.data?.item.body ?? '';
  const rows = diffLines(before.trimEnd(), after.trimEnd());
  const unchanged = rows.every((row) => row.mark === ' ');
  if (unchanged)
    return <p className="text-sm text-muted-foreground">{t('review.body_unchanged')}</p>;
  return (
    <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-3 text-xs leading-relaxed">
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
          {row.mark} {row.text || ' '}
        </div>
      ))}
    </pre>
  );
}

/**
 * A list before and after, for the fields that are sets rather than prose.
 *
 * Nothing is shown when they agree: a row saying a value did not change is a
 * row a reviewer has to read to learn nothing.
 */
export function ListDiff({
  label,
  before,
  after,
}: {
  label: string;
  before: readonly string[];
  after: readonly string[];
}) {
  const same =
    before.length === after.length && before.every((value, index) => value === after[index]);
  if (same) return null;
  return (
    <p className="text-sm">
      <span className="text-muted-foreground">{label}: </span>
      <span className="text-rose-700 line-through dark:text-rose-400">
        {before.join(', ') || '—'}
      </span>
      <span aria-hidden="true"> → </span>
      <span className="text-emerald-700 dark:text-emerald-400">{after.join(', ') || '—'}</span>
    </p>
  );
}
