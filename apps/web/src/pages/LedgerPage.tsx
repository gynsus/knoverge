import type { ActorSummary } from '@knoverge/contracts';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { ScrollText } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';

import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { ACTORS_KEY } from '@/lib/query-keys';
import { cn } from '@/lib/utils';
import { adminApi } from '../api/admin.ts';
import { useWorkspaceContext } from '../auth/use-workspace.ts';
import { ErrorNotice } from '../components/ErrorNotice.tsx';
import { EventRow } from '../components/ledger/EventRow.tsx';
import { GROUPS, typesIn, type Group } from '../components/ledger/groups.ts';

/** The periods the summary offers, in days. */
const PERIODS = [1, 7, 30] as const;
type Period = (typeof PERIODS)[number];

const PAGE = 50;

/**
 * The ledger of the workspace.
 *
 * The product is a knowledge ledger, and the ledger was the one thing with no
 * screen of its own: events were visible on an agent's card and in a category's
 * history, and `activity_digest` had no interface at all.
 *
 * Two bands, because they answer two questions. What did the week come to —
 * counts, and the items and decisions it touched, each leading to the thing
 * itself. And then the chain: newest first, read backwards a page at a time.
 * Never the knowledge text; the ledger holds ids, hashes and actor context and
 * has none to show (rule 4).
 */
export function LedgerPage() {
  const { t } = useTranslation();
  const workspaces = useWorkspaceContext();
  const [params, setParams] = useSearchParams();
  const [narrate, setNarrate] = useState(false);

  const asked = Number(params.get('days'));
  const period: Period = (PERIODS as readonly number[]).includes(asked) ? (asked as Period) : 7;
  const group: Group = GROUPS.includes(params.get('group') as Group)
    ? (params.get('group') as Group)
    : 'all';

  const set = (key: 'days' | 'group', value: string) => {
    const next = new URLSearchParams(params);
    next.set(key, value);
    setParams(next, { replace: true });
  };

  // Rounded down to the hour, so that a refetch does not ask about a slightly
  // different period and answer with slightly different counts.
  const since = useMemo(() => {
    const at = new Date();
    at.setMinutes(0, 0, 0);
    at.setHours(at.getHours() - period * 24);
    return at.toISOString();
  }, [period]);

  const digest = useQuery({
    queryKey: ['ledger', 'digest', since, narrate],
    queryFn: () => adminApi.events.digest({ since, include_narrative: narrate }),
    // The counts stay on screen while a different period or the prose is
    // fetched. Emptying the band and filling it again reads as the summary
    // having gone away, and it is the same summary either side of the wait.
    placeholderData: keepPreviousData,
  });

  const actors = useQuery({
    queryKey: ACTORS_KEY,
    queryFn: ({ signal }) => adminApi.workspace.actors(signal),
  });
  const byId = useMemo(
    () => new Map<string, ActorSummary>((actors.data?.actors ?? []).map((a) => [a.id, a])),
    [actors.data],
  );

  const feed = useInfiniteQuery({
    queryKey: ['ledger', 'feed', group],
    queryFn: ({ pageParam }) =>
      adminApi.events.list({
        newest_first: true,
        limit: PAGE,
        event_types: typesIn(group),
        // Reading backwards, so the cursor bounds the older end: the oldest
        // sequence of the page before. `after_sequence` bounds the wrong one
        // and would answer with the newest page again.
        ...(pageParam === undefined ? {} : { before_sequence: pageParam }),
      }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => (last.has_more ? last.next_sequence : undefined),
  });
  const events = feed.data?.pages.flatMap((page) => page.events) ?? [];

  return (
    <div className="grid gap-8">
      <div className="grid gap-1.5">
        <h2 className="text-2xl font-semibold tracking-tight">{t('ledger.title')}</h2>
        <p className="max-w-2xl text-sm text-muted-foreground">{t('ledger.intro')}</p>
        {/* Both bands narrow to this actor without `events.read_all`, and a
            quiet ledger is indistinguishable from a narrowed one. Saying so is
            the difference between "nothing happened" and "this is your part of
            it" — but not while the answer is outstanding: `can` is false before
            the permissions arrive, and a line that claims the page is narrowed
            and then vanishes is worse than no line. */}
        {!workspaces.isPending && !workspaces.can('events.read_all') && (
          <p className="max-w-2xl text-sm text-muted-foreground">{t('ledger.only_yours')}</p>
        )}
      </div>

      <ErrorNotice error={digest.isError ? digest.error : feed.isError ? feed.error : undefined} />

      <section aria-labelledby="ledger-summary" className="grid gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 id="ledger-summary" className="text-lg font-semibold">
            {t('ledger.summary')}
          </h3>
          {/* Inside the summary rather than above the page: it bounds this band
              and not the feed below, and a control that looked like it governed
              both would read as broken the moment the feed did not move. */}
          <div className="flex flex-wrap gap-2" role="group" aria-label={t('ledger.period')}>
            {PERIODS.map((days) => (
              <button
                key={days}
                type="button"
                onClick={() => set('days', String(days))}
                aria-pressed={days === period}
                className={cn(
                  'rounded-md border px-3 py-1.5 text-sm transition-colors',
                  'focus-visible:outline-ring focus-visible:outline-2 focus-visible:outline-offset-2',
                  days === period
                    ? 'border-primary bg-primary/10 font-medium text-foreground'
                    : 'border-border text-muted-foreground hover:bg-muted',
                )}
              >
                {t('ledger.periods', { count: days })}
              </button>
            ))}
          </div>
        </div>

        {digest.isPending && <p role="status">{t('common.loading')}</p>}
        {digest.data &&
          (digest.data.counts.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
              {t('ledger.quiet')}
            </p>
          ) : (
            <div className="grid gap-5">
              <ul className="flex flex-wrap gap-2" aria-label={t('ledger.counts')}>
                {digest.data.counts.map((entry) => (
                  <li
                    key={entry.event_type}
                    className="flex items-baseline gap-2 rounded-md border border-border px-3 py-1.5 text-sm"
                  >
                    <span>
                      {t(`events.types.${entry.event_type}`, { defaultValue: entry.event_type })}
                    </span>
                    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs tabular-nums text-muted-foreground">
                      {entry.count}
                    </span>
                  </li>
                ))}
              </ul>

              {/* Each entry leads to the thing itself. A summary that says a
                  decision was made and stops there leaves a reader holding an
                  id and nowhere to type it. */}
              <div className="grid gap-5 sm:grid-cols-2">
                <Touched
                  title={t('ledger.changed_items')}
                  empty={t('ledger.nothing_changed')}
                  rows={digest.data.changed_items.map((item) => ({
                    key: item.item_id,
                    label: item.title ?? item.item_id,
                    to: `/knowledge?item=${encodeURIComponent(item.item_id)}`,
                    // The digest names a change by its event type with the
                    // prefix taken off, so the ledger's own labels say what it
                    // was — one vocabulary for the whole screen.
                    note: item.change_kinds
                      .map((kind) => t(`events.types.knowledge.${kind}`, { defaultValue: kind }))
                      .join(', '),
                  }))}
                />
                <Touched
                  title={t('ledger.resolved_proposals')}
                  empty={t('ledger.nothing_resolved')}
                  rows={digest.data.resolved_proposals.map((proposal) => ({
                    key: proposal.proposal_id,
                    label: proposal.item_id ?? proposal.proposal_id,
                    to: `/review?proposal=${encodeURIComponent(proposal.proposal_id)}`,
                    note: t(`events.types.proposal.${proposal.status}`, {
                      defaultValue: proposal.status,
                    }),
                  }))}
                />
              </div>

              {/* The optional half of the digest, asked for and never assumed:
                  it costs a model call, and the counts above are the answer
                  without one (rule 9). */}
              {digest.data.narrative ? (
                <div className="grid gap-1 rounded-lg border border-border bg-muted/40 px-4 py-3">
                  <p className="text-sm">{digest.data.narrative.text}</p>
                  <p className="text-xs text-muted-foreground">
                    {t('ledger.narrative_by', { model: digest.data.narrative.model })}
                  </p>
                </div>
              ) : narrate && !digest.isFetching ? (
                <p className="text-sm text-muted-foreground">{t('ledger.no_narrative')}</p>
              ) : (
                <Button
                  variant="outline"
                  className="w-fit"
                  onClick={() => setNarrate(true)}
                  disabled={digest.isFetching}
                >
                  {t('ledger.describe')}
                </Button>
              )}
            </div>
          ))}
      </section>

      <section aria-labelledby="ledger-feed" className="grid gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 id="ledger-feed" className="text-lg font-semibold">
            {t('ledger.feed')}
          </h3>
          <Select
            value={group}
            onChange={(event) => set('group', event.target.value)}
            aria-label={t('ledger.group')}
            className="sm:w-56"
          >
            {GROUPS.map((name) => (
              <option key={name} value={name}>
                {t(`ledger.groups.${name}`)}
              </option>
            ))}
          </Select>
        </div>

        {feed.isPending && <p role="status">{t('common.loading')}</p>}
        {feed.data &&
          (events.length === 0 ? (
            <div className="grid min-h-40 place-items-center gap-3 rounded-lg border border-dashed border-border px-6 py-10 text-center">
              <span className="grid size-11 place-items-center rounded-lg bg-muted">
                <ScrollText aria-hidden="true" className="size-5 text-muted-foreground" />
              </span>
              <p className="text-sm text-muted-foreground">{t('ledger.empty')}</p>
            </div>
          ) : (
            <>
              <ul className="grid">
                {events.map((event) => (
                  <EventRow key={event.id} event={event} actors={byId} />
                ))}
              </ul>
              {feed.hasNextPage && (
                <Button
                  variant="outline"
                  className="w-fit"
                  onClick={() => void feed.fetchNextPage()}
                  disabled={feed.isFetchingNextPage}
                >
                  {feed.isFetchingNextPage ? t('common.working') : t('common.load_more')}
                </Button>
              )}
            </>
          ))}
      </section>
    </div>
  );
}

/** One of the two lists a summary carries: what it touched, and where that is. */
function Touched({
  title,
  empty,
  rows,
}: {
  title: string;
  empty: string;
  rows: { key: string; label: string; to: string; note: string }[];
}) {
  return (
    <div className="grid gap-2">
      <h4 className="text-sm font-medium">{title}</h4>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="grid gap-1.5 text-sm">
          {rows.map((row) => (
            <li key={row.key} className="flex min-w-0 items-baseline gap-2">
              <Link
                to={row.to}
                className="focus-visible:outline-ring min-w-0 truncate underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
              >
                {row.label}
              </Link>
              <span className="shrink-0 text-xs text-muted-foreground">{row.note}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
