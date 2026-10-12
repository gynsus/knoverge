import type {
  GardeningNotice,
  GardeningRun,
  GardeningRuleResult,
  GardeningSettings,
} from '@knoverge/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldSet } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { GARDENING_RUNS_KEY, GARDENING_SETTINGS_KEY } from '@/lib/query-keys';
import { relativeTime } from '@/lib/relative-time';
import { adminApi } from '../api/admin.ts';
import { useWorkspaceContext } from '../auth/use-workspace.ts';
import { ErrorNotice } from '../components/ErrorNotice.tsx';

/**
 * Whether this workspace tidies itself, and what it found when it last looked.
 *
 * The screen leads with what gardening produces rather than with the schedule,
 * because what it produces is work for a person: every finding is a proposal in
 * the review queue, and nothing here changes any knowledge (ADR 0039). Somebody
 * turning this on is agreeing to read what it files.
 *
 * It also shows the runs. A rule that found nothing and a rule that never ran
 * look the same from the queue, and the difference is the whole question of
 * whether gardening is working.
 */
export function GardeningPage() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const workspaces = useWorkspaceContext();
  const mayAdminister = workspaces.can('workspace.admin');

  const settings = useQuery({
    queryKey: GARDENING_SETTINGS_KEY,
    queryFn: ({ signal }) => adminApi.gardening.settings(signal),
  });
  const runs = useQuery({
    queryKey: GARDENING_RUNS_KEY,
    queryFn: ({ signal }) => adminApi.gardening.runs(signal),
  });

  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: GARDENING_SETTINGS_KEY }),
      client.invalidateQueries({ queryKey: GARDENING_RUNS_KEY }),
    ]);

  const run = useMutation({
    mutationFn: () => adminApi.gardening.run(),
    onSuccess: refresh,
  });

  return (
    <div className="grid gap-8">
      <div className="grid gap-1.5">
        <h2 className="text-2xl font-semibold tracking-tight">{t('gardening.title')}</h2>
        <p className="max-w-2xl text-sm text-muted-foreground">{t('gardening.intro')}</p>
        {settings.isPending && <p role="status">{t('common.loading')}</p>}
        <ErrorNotice error={settings.error} />
      </div>

      {settings.data && (
        <>
          <GardeningForm settings={settings.data.settings} mayAdminister={mayAdminister} />

          <section aria-labelledby="gardening-run-title" className="grid gap-4">
            <div className="grid gap-1.5">
              <h3 id="gardening-run-title" className="text-lg font-semibold">
                {t('gardening.runs')}
              </h3>
              <p className="max-w-2xl text-sm text-muted-foreground">{t('gardening.runs_hint')}</p>
            </div>

            {mayAdminister && (
              <div className="flex flex-wrap items-center gap-3">
                <Button type="button" onClick={() => run.mutate()} disabled={run.isPending}>
                  {run.isPending ? t('gardening.running') : t('gardening.run_now')}
                </Button>
                {/* Before the click, not after it: this one files proposals
                    somebody then has to read (WEB_UI.md rule 4). */}
                <p className="text-xs text-muted-foreground">{t('gardening.run_now_hint')}</p>
              </div>
            )}
            <ErrorNotice error={run.error} />

            {runs.isPending && <p role="status">{t('common.loading')}</p>}
            <ErrorNotice error={runs.error} />
            {runs.data && <Runs runs={runs.data.runs} />}
          </section>
        </>
      )}
    </div>
  );
}

/**
 * The schedule and the caps, in one form with one button.
 *
 * `gardening.save` takes them together, so the form is the same shape as the
 * call (WEB_UI.md rule 2m).
 */
function GardeningForm({
  settings,
  mayAdminister,
}: {
  settings: GardeningSettings;
  mayAdminister: boolean;
}) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [enabled, setEnabled] = useState(settings.enabled);
  const [intervalHours, setIntervalHours] = useState(String(settings.interval_hours));
  const [perRun, setPerRun] = useState(String(settings.max_findings_per_run));
  const [perRule, setPerRule] = useState(String(settings.max_findings_per_rule));
  const [saved, setSaved] = useState(false);

  const save = useMutation({
    mutationFn: () =>
      adminApi.gardening.save({
        enabled,
        interval_hours: Number(intervalHours),
        max_findings_per_run: Number(perRun),
        max_findings_per_rule: Number(perRule),
      }),
    onSuccess: async () => {
      setSaved(true);
      await client.invalidateQueries({ queryKey: GARDENING_SETTINGS_KEY });
    },
  });

  return (
    <form
      className="grid gap-8"
      onSubmit={(event) => {
        event.preventDefault();
        setSaved(false);
        save.mutate();
      }}
    >
      <ErrorNotice error={save.error} />

      <section aria-labelledby="gardening-schedule-title" className="grid gap-4">
        <div className="grid gap-1.5">
          <h3 id="gardening-schedule-title" className="text-lg font-semibold">
            {t('gardening.schedule')}
          </h3>
          <p className="max-w-2xl text-sm text-muted-foreground">{t('gardening.schedule_hint')}</p>
        </div>
        <FieldSet disabled={!mayAdminister}>
          <label className="flex items-start gap-3 text-sm">
            <Checkbox
              checked={enabled}
              onCheckedChange={(next) => setEnabled(next === true)}
              disabled={!mayAdminister}
            />
            <span className="grid gap-1">
              <span className="font-medium">{t('gardening.enabled')}</span>
              <span className="text-xs text-muted-foreground">{t('gardening.enabled_hint')}</span>
            </span>
          </label>
          <Field label={t('gardening.interval')} hint={t('gardening.interval_hint')}>
            <Input
              type="number"
              min={1}
              max={168}
              required
              value={intervalHours}
              onChange={(event) => setIntervalHours(event.target.value)}
            />
          </Field>
          <Field label={t('gardening.per_run')} hint={t('gardening.per_run_hint')}>
            <Input
              type="number"
              min={1}
              max={500}
              required
              value={perRun}
              onChange={(event) => setPerRun(event.target.value)}
            />
          </Field>
          <Field label={t('gardening.per_rule')} hint={t('gardening.per_rule_hint')}>
            <Input
              type="number"
              min={1}
              max={500}
              required
              value={perRule}
              onChange={(event) => setPerRule(event.target.value)}
            />
          </Field>
        </FieldSet>
      </section>

      <section aria-labelledby="gardening-rules-title" className="grid gap-4">
        <div className="grid gap-1.5">
          <h3 id="gardening-rules-title" className="text-lg font-semibold">
            {t('gardening.rules')}
          </h3>
          <p className="max-w-2xl text-sm text-muted-foreground">{t('gardening.rules_hint')}</p>
        </div>
        <ul className="grid gap-3">
          {settings.rules.map((rule) => (
            <li key={rule} className="grid">
              <Card className="grid gap-1 p-4">
                <CardTitle className="text-base">{t(`gardening.rule.${rule}.title`)}</CardTitle>
                <p className="text-sm text-muted-foreground">
                  {t(`gardening.rule.${rule}.description`)}
                </p>
              </Card>
            </li>
          ))}
        </ul>
      </section>

      {mayAdminister && (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? t('common.working') : t('gardening.save')}
          </Button>
          {saved && !save.isPending && (
            <span role="status" className="text-sm text-muted-foreground">
              {t('gardening.saved')}
            </span>
          )}
        </div>
      )}
      {!mayAdminister && (
        <p className="text-sm text-muted-foreground">{t('gardening.forbidden')}</p>
      )}
    </form>
  );
}

function Runs({ runs }: { runs: GardeningRun[] }) {
  const { t, i18n } = useTranslation();
  if (runs.length === 0) return <p>{t('gardening.no_runs')}</p>;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('gardening.run_when')}</TableHead>
          <TableHead>{t('gardening.run_trigger')}</TableHead>
          <TableHead>{t('gardening.run_filed')}</TableHead>
          <TableHead>{t('gardening.run_rules')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((run) => (
          <TableRow key={run.id}>
            <TableCell label={t('gardening.run_when')}>
              {relativeTime(run.started_at, i18n.language)}
              {/* A run with no end is one a restart interrupted, and saying so
                  is the difference between that and a run that found nothing. */}
              {run.finished_at === null && (
                <>
                  {' '}
                  <Badge variant="outline">{t('gardening.unfinished')}</Badge>
                </>
              )}
            </TableCell>
            <TableCell label={t('gardening.run_trigger')}>
              {t(`gardening.trigger.${run.trigger}`)}
            </TableCell>
            <TableCell label={t('gardening.run_filed')}>
              {run.findings_filed}
              {run.reached_cap && (
                <>
                  {' '}
                  <Badge variant="outline">{t('gardening.capped')}</Badge>
                </>
              )}
            </TableCell>
            <TableCell label={t('gardening.run_rules')}>
              {run.error !== null && <p className="text-sm text-destructive">{run.error}</p>}
              <ul className="grid gap-1">
                {run.rules.map((result) => (
                  <li key={result.rule} className="text-sm">
                    <RuleResult result={result} />
                  </li>
                ))}
              </ul>
              {/* With the run that saw them rather than in a list of their own:
                  there is nothing to approve and nothing to dismiss, so a
                  reader wants what is true now, which is the newest run
                  (ADR 0043). */}
              {run.notices.length > 0 && <Notices notices={run.notices} />}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/**
 * What the run saw that names no write.
 *
 * Each one says what kind of thing it is about, because a reader has to know
 * what they are looking for before they can go and look — and because for some
 * kinds there is a screen and for others there is not.
 */
function Notices({ notices }: { notices: GardeningNotice[] }) {
  const { t } = useTranslation();
  return (
    <div className="mt-2 grid gap-1">
      <p className="text-xs font-medium">{t('gardening.notices')}</p>
      <p className="text-xs text-muted-foreground">{t('gardening.notices_hint')}</p>
      <ul className="grid gap-1">
        {notices.map((notice) => (
          <li key={`${notice.rule}:${notice.subject_id}`} className="text-sm">
            <Subject notice={notice} />{' '}
            <span className="text-muted-foreground">{notice.reason}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * What the notice is about, and the way there where there is one.
 *
 * A knowledge item has a screen that can fix it, so the kind is the link to it:
 * a notice nobody can act on from here is worth less than one that puts the
 * item in front of them. A source row and a file have no screen of their own,
 * and a link to nowhere would be worse than a word.
 */
function Subject({ notice }: { notice: GardeningNotice }) {
  const { t } = useTranslation();
  const label = t(`gardening.subject.${notice.subject_type}`);
  if (notice.subject_type !== 'knowledge_item') return <Badge variant="outline">{label}</Badge>;
  return (
    <Link
      to={`/knowledge?item=${encodeURIComponent(notice.subject_id)}`}
      className="underline-offset-4 hover:underline"
    >
      <Badge variant="outline">{label}</Badge>
    </Link>
  );
}

/**
 * What one rule did, in one line.
 *
 * The numbers rather than a verdict: read, found, filed. A rule that filed less
 * than it found says which cap stopped it, because the two are fixed in
 * different fields of the same form.
 */
function RuleResult({ result }: { result: GardeningRuleResult }) {
  const { t } = useTranslation();
  return (
    <>
      <span className="font-medium">{t(`gardening.rule.${result.rule}.title`)}</span>{' '}
      <span className="text-muted-foreground">
        {t('gardening.result', {
          examined: result.examined,
          found: result.found,
          filed: result.filed,
        })}
      </span>
      {result.limited !== null && (
        <>
          {' '}
          <Badge variant="outline">{t(`gardening.limited.${result.limited}`)}</Badge>
        </>
      )}
    </>
  );
}
