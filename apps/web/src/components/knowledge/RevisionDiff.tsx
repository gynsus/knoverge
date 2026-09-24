import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { adminApi } from '../../api/admin.ts';
import { ErrorNotice } from '../ErrorNotice.tsx';

/** A frontmatter value as a person reads it. Lists are lists, not JSON. */
function readable(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) return value.length === 0 ? '—' : value.map(String).join(', ');
  return String(value);
}

/**
 * What one revision changed, against the one before it.
 *
 * Fetched only when somebody asks. A history of forty revisions would be forty
 * diffs nobody read, and the server computes each one by reading two files out
 * of Git.
 */
export function RevisionDiff({
  itemId,
  from,
  to,
}: {
  itemId: string;
  /** The revision before this one. */
  from: string;
  to: string;
}) {
  const { t } = useTranslation();
  const diff = useQuery({
    queryKey: ['knowledge', 'items', itemId, 'diff', from, to],
    queryFn: ({ signal }) => adminApi.knowledge.diff(itemId, from, to, signal),
  });

  if (diff.isPending)
    return (
      <p role="status" className="text-xs text-muted-foreground">
        {t('common.loading')}
      </p>
    );
  if (diff.error) return <ErrorNotice error={diff.error} />;

  const patch = diff.data?.body_diff ?? '';
  const changes = diff.data?.metadata_changes ?? [];

  return (
    <div className="grid gap-2">
      {/* What changed about the item, answered rather than left in the patch
          for a reader to pick out. */}
      {changes.length > 0 && (
        <ul className="grid gap-1 text-xs">
          {changes.map((change, index) => (
            <li key={index}>
              <span className="text-muted-foreground">{change.field}: </span>
              <span className="text-rose-700 line-through dark:text-rose-400">
                {readable(change.from)}
              </span>
              <span aria-hidden="true"> → </span>
              <span className="text-emerald-700 dark:text-emerald-400">{readable(change.to)}</span>
            </li>
          ))}
        </ul>
      )}
      {patch === '' ? (
        <p className="text-xs text-muted-foreground">{t('knowledge.text_unchanged')}</p>
      ) : (
        <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-3 text-xs leading-relaxed">
          {patch.split('\n').map((line, index) => (
            <div
              key={index}
              className={
                line.startsWith('+') && !line.startsWith('+++')
                  ? 'text-emerald-700 dark:text-emerald-400'
                  : line.startsWith('-') && !line.startsWith('---')
                    ? 'text-rose-700 dark:text-rose-400'
                    : 'text-muted-foreground'
              }
            >
              {line || ' '}
            </div>
          ))}
        </pre>
      )}
    </div>
  );
}
