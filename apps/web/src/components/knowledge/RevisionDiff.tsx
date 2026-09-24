import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { Patch, WasNow } from '@/components/ui/diff';
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
        <ul className="grid gap-1">
          {changes.map((change, index) => (
            <li key={index}>
              <WasNow label={change.field} was={readable(change.from)} now={readable(change.to)} />
            </li>
          ))}
        </ul>
      )}
      {patch === '' ? (
        <p className="text-xs text-muted-foreground">{t('knowledge.text_unchanged')}</p>
      ) : (
        <Patch text={patch} />
      )}
    </div>
  );
}
