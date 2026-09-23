import type { SyncRunSummary } from '@knoverge/contracts';
import { useQuery } from '@tanstack/react-query';
import { Inbox } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { relativeTime } from '@/lib/relative-time';
import { adminApi } from '../../api/admin.ts';
import { ErrorNotice } from '../ErrorNotice.tsx';

/**
 * What one reconciliation pass found.
 *
 * The numbers are the point. An agent offering twelve hundred candidates and
 * finding nine hundred of them already recorded is the product working; the
 * same agent proposing nine hundred items is the product having failed, and
 * the difference is visible here before anybody opens the review inbox.
 */
export function SyncRunDetails({ run }: { run: SyncRunSummary }) {
  const { t, i18n } = useTranslation();
  const proposals = useQuery({
    queryKey: ['sync-run-proposals', run.sync_session_id],
    queryFn: () => adminApi.sync.proposals(run.sync_session_id),
  });

  /** In the order somebody reads them: what was skipped, then what needs work. */
  const order = [
    'exact_known',
    'agent_copy_stale',
    'likely_match',
    'ambiguous',
    'server_copy_stale',
    'conflict',
    'new_candidate',
    'ignored',
  ] as const;

  return (
    <div className="grid content-start gap-5 p-4 sm:p-6">
      <div className="grid gap-2">
        <p className="text-sm text-muted-foreground">
          {run.source_system}
          {run.source_namespace ? ` · ${run.source_namespace}` : ''}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={run.state === 'completed' ? 'outline' : 'default'}>
            {t(`sync.states.${run.state}`)}
          </Badge>
          {run.pending_count > 0 && (
            <Badge variant="outline">{t('sync.pending', { count: run.pending_count })}</Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {t('sync.started', { when: relativeTime(run.created_at, i18n.language) })}
          {run.completed_at
            ? ` · ${t('sync.finished', { when: relativeTime(run.completed_at, i18n.language) })}`
            : ''}
        </p>
      </div>

      <Separator />

      <section className="grid gap-1.5">
        <h4 className="text-sm font-medium">{t('sync.offered', { count: run.candidate_count })}</h4>
        <dl className="grid gap-1 text-sm">
          {order
            .filter((name) => (run.counts[name] ?? 0) > 0)
            .map((name) => (
              <div key={name} className="flex items-baseline justify-between gap-3">
                <dt className="text-muted-foreground">{t(`sync.classifications.${name}`)}</dt>
                <dd className="tabular-nums">{run.counts[name]}</dd>
              </div>
            ))}
        </dl>
        {run.candidate_count === 0 && (
          <p className="text-sm text-muted-foreground">{t('sync.nothing_offered')}</p>
        )}
      </section>

      <Separator />

      <section className="grid gap-2">
        <h4 className="text-sm font-medium">{t('sync.proposals')}</h4>
        <ErrorNotice error={proposals.isError ? proposals.error : undefined} />
        {proposals.isPending && <p role="status">{t('common.loading')}</p>}
        {proposals.data && (
          <>
            <p className="text-sm text-muted-foreground">
              {t('sync.proposal_count', { count: proposals.data.proposals.length })}
            </p>
            {proposals.data.proposals.length > 0 && (
              <Button asChild variant="outline" size="sm" className="justify-self-start">
                <Link to={`/review?sync_session_id=${run.sync_session_id}`}>
                  <Inbox aria-hidden="true" className="size-4" />
                  {t('sync.review_them')}
                </Link>
              </Button>
            )}
          </>
        )}
      </section>
    </div>
  );
}
