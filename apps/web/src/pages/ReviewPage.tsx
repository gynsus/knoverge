import type { ProposalSummary } from '@knoverge/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Inbox, Keyboard, Search, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { useMediaQuery } from '@/lib/use-media-query';
import { ACTORS_KEY } from '@/lib/query-keys';
import { adminApi } from '../api/admin.ts';
import { ErrorNotice } from '../components/ErrorNotice.tsx';
import { ProposalDetail } from '../components/review/ProposalDetail.tsx';
import { QueueItem } from '../components/review/QueueItem.tsx';
import { inSegment, type Segment } from '../components/review/proposal.ts';

const INBOX_KEY = ['proposals', 'inbox'] as const;

/** The piles a reviewer sorts the queue into, in the order they are offered. */
const SEGMENTS: Segment[] = ['all', 'conflict', 'create', 'change', 'today'];

/**
 * The review inbox.
 *
 * A queue of decisions, not a list of records. Rule 14 sends every agent write
 * here unless a policy rule says otherwise, so this is where an agent's work
 * becomes the workspace's knowledge — and the screen's job is to make that
 * decision quick and safe, not to offer a form.
 *
 * The queue is on the left and the decision on the right, because a reviewer
 * works down a list: moving to the next one must not cost a navigation. Below
 * the large breakpoint there is no room for both and the decision opens over
 * the queue instead; trying to keep a split view on a phone gives two columns
 * too narrow to read.
 */
export function ReviewPage() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState('');
  const [segment, setSegment] = useState<Segment>('all');
  const [proposerId, setProposerId] = useState('all');
  const [oldestFirst, setOldestFirst] = useState(true);
  // Which ones have been opened, so the queue can mark what is new. In this
  // browser and this session only: it is a reading aid, not a fact about the
  // proposal, and a proposal is not "read" because somebody else read it.
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => new Set());
  const [shortcutsShown, setShortcutsShown] = useState(false);
  const searchBox = useRef<HTMLInputElement>(null);
  // Decided here rather than with `hidden lg:block`, because a class hides an
  // element and leaves it in the document: two copies of the panel would be
  // two of every field, two ids and two effects fighting over the focus.
  const wide = useMediaQuery('(min-width: 1024px)');

  // In the address, like every other object this interface opens, so a
  // reviewer can send somebody the proposal rather than the queue it is in.
  const selectedId = params.get('proposal');
  // A run's proposals were judged by one agent against one body of material,
  // so reading them together is how that judgement gets checked.
  const runId = params.get('sync_session_id');

  const select = useCallback(
    (id: string | null) => {
      const next = new URLSearchParams(params);
      if (id === null) next.delete('proposal');
      else {
        next.set('proposal', id);
        setSeen((current) => new Set(current).add(id));
      }
      setParams(next, { replace: true });
    },
    [params, setParams],
  );

  const options = runId ? { syncSessionId: runId } : {};
  const pending = useQuery({
    queryKey: [...INBOX_KEY, 'pending', runId ?? 'all'],
    queryFn: ({ signal }) => adminApi.proposals.list('pending', options, signal),
  });
  // A second call rather than one without a status: everything unresolved
  // belongs in the queue, and everything resolved does not.
  const conflicts = useQuery({
    queryKey: [...INBOX_KEY, 'conflict', runId ?? 'all'],
    queryFn: ({ signal }) => adminApi.proposals.list('conflict', options, signal),
  });
  const selected = useQuery({
    queryKey: ['proposals', 'one', selectedId],
    queryFn: ({ signal }) => adminApi.proposals.get(selectedId as string, signal),
    enabled: selectedId !== null,
  });
  // Who proposed each one. A queue of ninety from one import is unreadable
  // without it, and the ids the proposals carry are not names.
  const actors = useQuery({
    queryKey: ACTORS_KEY,
    queryFn: ({ signal }) => adminApi.workspace.actors(signal),
  });
  const nameOf = useMemo(
    () => new Map((actors.data?.actors ?? []).map((a) => [a.id as string, a.display_name])),
    [actors.data],
  );

  const all = useMemo(
    () => [...(pending.data?.proposals ?? []), ...(conflicts.data?.proposals ?? [])],
    [pending.data, conflicts.data],
  );

  const now = useMemo(() => new Date(), []);
  const counts = useMemo(
    () =>
      Object.fromEntries(
        SEGMENTS.map((key) => [key, all.filter((p) => inSegment(p, key, now)).length]),
      ) as Record<Segment, number>,
    [all, now],
  );

  const proposers = useMemo(
    () => [...new Set(all.map((p) => p.proposed_by_actor_id as string))],
    [all],
  );

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return all
      .filter(
        (p) =>
          inSegment(p, segment, now) &&
          (proposerId === 'all' || p.proposed_by_actor_id === proposerId) &&
          (needle === '' ||
            (p.title ?? '').toLowerCase().includes(needle) ||
            (p.reason ?? '').toLowerCase().includes(needle) ||
            (nameOf.get(p.proposed_by_actor_id) ?? '').toLowerCase().includes(needle)),
      )
      .sort((a, b) => {
        // A conflict is somebody's work about to be lost, so it goes first
        // whichever way the rest is ordered.
        const stuck = Number(b.status === 'conflict') - Number(a.status === 'conflict');
        if (stuck !== 0) return stuck;
        const at = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        return oldestFirst ? at : -at;
      });
  }, [all, segment, proposerId, query, nameOf, now, oldestFirst]);

  const resolved = async () => {
    // To the next one rather than to nothing: a reviewer working down a queue
    // has already decided to look at what follows.
    const index = visible.findIndex((p) => p.id === selectedId);
    const next = visible[index + 1] ?? visible[index - 1] ?? null;
    select(next ? next.id : null);
    await client.invalidateQueries({ queryKey: ['proposals'] });
    await client.invalidateQueries({ queryKey: ['knowledge'] });
  };

  const step = useCallback(
    (by: 1 | -1) => {
      if (visible.length === 0) return;
      const index = visible.findIndex((p) => p.id === selectedId);
      const target = visible[Math.min(Math.max(index + by, 0), visible.length - 1)];
      if (target) select(target.id);
    },
    [visible, selectedId, select],
  );

  // The keys a reviewer working a queue reaches for. Nothing irreversible
  // happens on one: `r` opens the rejection dialog rather than rejecting, and
  // approving is a button because it writes a revision.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.tagName === 'SELECT' ||
        target?.isContentEditable === true;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 'Escape' && typing) {
        (target as HTMLElement).blur();
        return;
      }
      if (typing) return;
      if (event.key === 'j') step(1);
      else if (event.key === 'k') step(-1);
      else if (event.key === '/') {
        event.preventDefault();
        searchBox.current?.focus();
      } else if (event.key === '?') setShortcutsShown((shown) => !shown);
      else if (event.key === 'Escape' && selectedId) select(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step, select, selectedId]);

  const filtered = query !== '' || segment !== 'all' || proposerId !== 'all';
  const reset = () => {
    setQuery('');
    setSegment('all');
    setProposerId('all');
  };

  const detail =
    selected.data && selectedId ? (
      <ProposalDetail
        key={selected.data.proposal.id}
        proposal={selected.data.proposal}
        proposer={
          nameOf.get(selected.data.proposal.proposed_by_actor_id) ??
          selected.data.proposal.proposed_by_actor_id
        }
        onResolved={resolved}
      />
    ) : null;

  return (
    <div className="grid gap-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="grid gap-1.5">
          <h2 className="text-2xl font-semibold tracking-tight">{t('review.title')}</h2>
          <p className="max-w-2xl text-sm text-muted-foreground">{t('review.intro')}</p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="shrink-0 text-muted-foreground"
          aria-expanded={shortcutsShown}
          onClick={() => setShortcutsShown((shown) => !shown)}
        >
          <Keyboard aria-hidden="true" className="size-4" />
          {t('review.shortcuts')}
        </Button>
      </div>

      {shortcutsShown && (
        <dl className="grid gap-x-6 gap-y-1 rounded-lg border border-border bg-muted/40 p-4 text-sm sm:grid-cols-2">
          {(['next', 'previous', 'search', 'close', 'help'] as const).map((key) => (
            <div key={key} className="flex items-baseline justify-between gap-3">
              <dt className="text-muted-foreground">{t(`review.shortcut_keys.${key}.what`)}</dt>
              <dd>
                <kbd className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-xs">
                  {t(`review.shortcut_keys.${key}.key`)}
                </kbd>
              </dd>
            </div>
          ))}
        </dl>
      )}

      {runId && (
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <Badge variant="outline">{t('review.from_run')}</Badge>
          <Button
            type="button"
            variant="link"
            className="h-auto p-0"
            onClick={() => setParams({}, { replace: true })}
          >
            {t('review.show_all')}
          </Button>
        </p>
      )}

      {/* The piles, as counts that are also the filter. Seeing that three of
          the twelve are conflicts and being able to say "those three" is the
          difference between a queue and a list. */}
      <div className="flex flex-wrap gap-2">
        {SEGMENTS.map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setSegment(key)}
            aria-pressed={segment === key}
            className={cn(
              'flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm transition-colors',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
              segment === key
                ? 'border-primary bg-primary/10 font-medium text-foreground'
                : 'border-border text-muted-foreground hover:bg-muted',
            )}
          >
            {t(`review.segments.${key}`)}
            <span
              className={cn(
                'rounded px-1.5 py-0.5 font-mono text-xs',
                key === 'conflict' && counts[key] > 0
                  ? 'bg-destructive/15 text-destructive'
                  : 'bg-muted text-muted-foreground',
              )}
            >
              {counts[key]}
            </span>
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="relative min-w-0 flex-1 lg:max-w-md">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            ref={searchBox}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={t('review.search')}
            placeholder={t('review.search')}
            className="pr-9 pl-9"
          />
          {query !== '' && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label={t('review.search_clear')}
              className="absolute top-1/2 right-3 -translate-y-1/2 rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3 sm:flex">
          <Select
            value={proposerId}
            onChange={(e) => setProposerId(e.target.value)}
            aria-label={t('review.filter_proposer')}
            className="sm:w-52"
          >
            <option value="all">{t('review.all_proposers')}</option>
            {proposers.map((id) => (
              <option key={id} value={id}>
                {nameOf.get(id) ?? id}
              </option>
            ))}
          </Select>
          <Select
            value={oldestFirst ? 'oldest' : 'newest'}
            onChange={(e) => setOldestFirst(e.target.value === 'oldest')}
            aria-label={t('review.sort')}
            className="sm:w-52"
          >
            <option value="oldest">{t('review.sort_oldest')}</option>
            <option value="newest">{t('review.sort_newest')}</option>
          </Select>
        </div>
      </div>

      <ErrorNotice error={pending.error ?? conflicts.error ?? selected.error} />
      {pending.isPending && <p role="status">{t('common.loading')}</p>}

      {pending.data && (
        <div
          className={cn(
            'grid items-start gap-5',
            wide && 'lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]',
          )}
        >
          <div className="grid gap-2">
            <div className="flex min-h-8 items-center justify-between gap-2">
              <p role="status" className="text-sm text-muted-foreground">
                {t('review.count', { count: visible.length })}
              </p>
              {filtered && visible.length > 0 && (
                <Button variant="ghost" size="sm" onClick={reset} className="text-muted-foreground">
                  {t('review.reset_filters')}
                </Button>
              )}
            </div>
            {visible.length > 0 ? (
              <ul
                aria-label={t('review.queue')}
                className="grid divide-y divide-border overflow-hidden rounded-lg border border-border"
              >
                {visible.map((proposal: ProposalSummary) => (
                  <li key={proposal.id}>
                    <QueueItem
                      proposal={proposal}
                      proposer={
                        nameOf.get(proposal.proposed_by_actor_id) ?? proposal.proposed_by_actor_id
                      }
                      selected={proposal.id === selectedId}
                      seen={seen.has(proposal.id)}
                      onSelect={() => select(proposal.id)}
                    />
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState filtered={filtered} onReset={reset} />
            )}
          </div>

          {/* The decision, beside the queue on a wide screen. */}
          {wide && (
            <div className="rounded-lg border border-border p-4 sm:p-6">
              {detail ?? <p className="text-sm text-muted-foreground">{t('review.choose')}</p>}
            </div>
          )}
        </div>
      )}

      {/* And over it on a narrow one, where two columns would be two columns
          too narrow to read. */}
      <Sheet open={!wide && selectedId !== null} onOpenChange={(open) => !open && select(null)}>
        <SheetContent side="right" className="w-full gap-0 overflow-y-auto sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle>{selected.data?.proposal.title ?? t('review.title')}</SheetTitle>
            <SheetDescription className="sr-only">{t('review.intro')}</SheetDescription>
          </SheetHeader>
          <div className="p-4 sm:p-6">{detail}</div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

function EmptyState({ filtered, onReset }: { filtered: boolean; onReset: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="grid min-h-56 place-items-center gap-4 rounded-lg border border-dashed border-border px-6 py-10 text-center">
      <span className="grid size-11 place-items-center rounded-lg bg-muted">
        <Inbox className="size-5 text-muted-foreground" aria-hidden="true" />
      </span>
      <div className="grid gap-1">
        <h3 className="font-medium">{filtered ? t('review.empty_filtered') : t('review.empty')}</h3>
        <p className="mx-auto max-w-sm text-sm text-muted-foreground">
          {filtered ? t('review.empty_filtered_hint') : t('review.empty_hint')}
        </p>
      </div>
      {filtered && (
        <Button variant="outline" onClick={onReset}>
          {t('review.reset_filters')}
        </Button>
      )}
    </div>
  );
}
