import type { ActorSummary, EventSummary, EventsListResponse } from '@knoverge/contracts';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { TAXONOMY_HISTORY_KEY } from '@/lib/query-keys';
import { relativeTime } from '@/lib/relative-time';
import { apiPost } from '../../api/client.ts';
import { ErrorNotice } from '../ErrorNotice.tsx';

/** The seven things that can happen to a category. */
const CATEGORY_EVENTS = [
  'category.proposed',
  'category.created',
  'category.updated',
  'category.moved',
  'category.merged',
  'category.archived',
  'category.restored',
] as const;

/**
 * What has happened to this taxonomy, newest first.
 *
 * Read from the event ledger rather than from a log of its own: the ledger
 * already records every category change with who made it, and a second
 * history would be a second thing to keep true.
 */
export function TaxonomyHistory({
  open,
  onOpenChange,
  actors,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actors: readonly ActorSummary[];
}) {
  const { t, i18n } = useTranslation();
  const history = useQuery({
    queryKey: TAXONOMY_HISTORY_KEY,
    queryFn: () =>
      apiPost<EventsListResponse>('/v1/events_list', {
        event_types: [...CATEGORY_EVENTS],
        limit: 200,
      }),
    enabled: open,
  });

  const nameOf = (event: EventSummary) =>
    actors.find((a) => a.id === event.actor_id)?.display_name ?? event.actor_id;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{t('taxonomy.history')}</SheetTitle>
          <SheetDescription>{t('taxonomy.history_intro')}</SheetDescription>
        </SheetHeader>
        <div className="p-4">
          {history.isPending && open && <p role="status">{t('common.loading')}</p>}
          <ErrorNotice error={history.isError ? history.error : undefined} />
          {history.data && history.data.events.length === 0 && (
            <p className="text-sm text-muted-foreground">{t('taxonomy.history_empty')}</p>
          )}
          {history.data && history.data.events.length > 0 && (
            <ol className="grid gap-4">
              {[...history.data.events].reverse().map((event) => (
                <li key={event.id} className="grid gap-0.5 text-sm">
                  <span>
                    {t(`taxonomy.events.${event.event_type}`, {
                      path: String(event.metadata['path'] ?? ''),
                      into: String(event.metadata['into_path'] ?? ''),
                    })}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {t('taxonomy.history_line', {
                      who: nameOf(event),
                      when: relativeTime(event.created_at, i18n.language),
                      version: Number(event.metadata['taxonomy_version'] ?? 0),
                    })}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
