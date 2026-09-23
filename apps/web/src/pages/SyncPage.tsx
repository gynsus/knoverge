import type { SyncRunSummary } from '@knoverge/contracts';
import { useQuery } from '@tanstack/react-query';
import { Bot, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { relativeTime } from '@/lib/relative-time';
import { adminApi } from '../api/admin.ts';
import { ErrorNotice } from '../components/ErrorNotice.tsx';
import { SyncRunDetails } from '../components/sync/SyncRunDetails.tsx';

const SYNC_RUNS_KEY = ['sync-runs'] as const;

/**
 * What agents found when they reconciled.
 *
 * The screen the product's own claim is measured on: an agent arriving with
 * twelve hundred things it believes it knows, and finding nine hundred of them
 * already recorded, is this working. One card per run, and the run itself in a
 * drawer, like every other object here.
 */
export function SyncPage() {
  const { t } = useTranslation();
  const [inspecting, setInspecting] = useState<string | null>(null);
  const runs = useQuery({
    queryKey: SYNC_RUNS_KEY,
    queryFn: ({ signal }) => adminApi.sync.runs(signal),
  });
  const all = runs.data?.runs ?? [];
  const inspected = all.find((r) => r.sync_session_id === inspecting) ?? null;

  return (
    <div className="grid gap-5">
      <div className="grid gap-1.5">
        <h2 className="text-2xl font-semibold tracking-tight">{t('sync.title')}</h2>
        <p className="max-w-2xl text-sm text-muted-foreground">{t('sync.intro')}</p>
      </div>

      <ErrorNotice error={runs.isError ? runs.error : undefined} />
      {runs.isPending && <p role="status">{t('common.loading')}</p>}

      {runs.data &&
        (all.length === 0 ? (
          <div className="grid min-h-60 place-items-center gap-4 rounded-lg border border-dashed border-border px-6 py-12 text-center">
            <span className="grid size-11 place-items-center rounded-lg bg-muted">
              <RefreshCw aria-hidden="true" className="size-5 text-muted-foreground" />
            </span>
            <div className="grid gap-1">
              <h3 className="font-medium">{t('sync.empty')}</h3>
              <p className="mx-auto max-w-sm text-sm text-muted-foreground">
                {t('sync.empty_hint')}
              </p>
            </div>
          </div>
        ) : (
          <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {all.map((run) => (
              <li key={run.sync_session_id} className="grid">
                <RunCard run={run} onInspect={() => setInspecting(run.sync_session_id)} />
              </li>
            ))}
          </ul>
        ))}

      <Sheet open={inspected !== null} onOpenChange={(open) => !open && setInspecting(null)}>
        <SheetContent side="right" className="w-full gap-0 overflow-y-auto sm:max-w-md">
          <SheetHeader>
            <SheetTitle>{inspected?.agent_name ?? t('sync.title')}</SheetTitle>
            <SheetDescription className="sr-only">{t('sync.intro')}</SheetDescription>
          </SheetHeader>
          {inspected && <SyncRunDetails run={inspected} />}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function RunCard({ run, onInspect }: { run: SyncRunSummary; onInspect: () => void }) {
  const { t, i18n } = useTranslation();
  const known = run.counts['exact_known'] ?? 0;
  return (
    <Card className="group relative grid grid-rows-[auto_1fr] transition-colors focus-within:ring-2 focus-within:ring-ring hover:border-foreground/20">
      <CardHeader className="gap-3 pb-4">
        <CardTitle className="truncate text-lg">
          <button
            type="button"
            onClick={onInspect}
            aria-label={t('sync.inspect', { name: run.agent_name })}
            className="text-left after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
          >
            {run.agent_name}
          </button>
        </CardTitle>
        <CardDescription className="truncate">
          {run.source_system}
          {run.source_namespace ? ` · ${run.source_namespace}` : ''}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid content-end gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={run.state === 'completed' ? 'outline' : 'default'}>
            {t(`sync.states.${run.state}`)}
          </Badge>
          {run.pending_count > 0 && (
            <Badge variant="outline">{t('sync.pending', { count: run.pending_count })}</Badge>
          )}
        </div>
        {/* The one number the product is judged on: how much an agent offered
            that the workspace already had. */}
        <p className="text-sm text-muted-foreground">
          {t('sync.already_known', { known, offered: run.candidate_count })}
        </p>
        <p className="flex items-center gap-2 border-t border-border pt-4 text-xs text-muted-foreground">
          <Bot aria-hidden="true" className="size-3.5 shrink-0" />
          {t('sync.started', { when: relativeTime(run.created_at, i18n.language) })}
        </p>
      </CardContent>
    </Card>
  );
}
