import type { ActorId, EventSummary } from '@knoverge/contracts';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { Badge } from '@/components/ui/badge';
import { relativeTime } from '@/lib/relative-time';
import { adminApi } from '../../api/admin.ts';
import { ErrorNotice } from '../ErrorNotice.tsx';

/**
 * What this agent has actually done.
 *
 * The ledger, narrowed to one actor and read newest first — which is what
 * somebody asks of an agent, rather than the first page of a workspace's
 * whole history. Not raw rows: an event says what happened and to what, and
 * the ledger holds no knowledge text to show even if this wanted to (rule 4).
 */
export function AgentActivity({ actorId }: { actorId: ActorId }) {
  const { t, i18n } = useTranslation();
  const events = useQuery({
    queryKey: ['events', 'agent', actorId],
    queryFn: () => adminApi.events.list({ actor_id: actorId, newest_first: true, limit: 50 }),
  });

  if (events.isPending)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {t('common.loading')}
      </p>
    );
  if (events.error) return <ErrorNotice error={events.error} />;
  if (events.data.events.length === 0)
    return <p className="text-sm text-muted-foreground">{t('agents.no_activity')}</p>;

  return (
    <ul className="grid gap-3 text-sm">
      {events.data.events.map((event: EventSummary) => (
        <li key={event.id} className="grid gap-0.5">
          <span className="flex flex-wrap items-baseline gap-2">
            <Badge variant="outline" className="font-normal">
              {t(`events.types.${event.event_type}`, { defaultValue: event.event_type })}
            </Badge>
            <span className="text-xs text-muted-foreground">
              {relativeTime(event.created_at, i18n.language)}
            </span>
          </span>
          {event.category_paths.length > 0 && (
            <span className="text-xs text-muted-foreground">{event.category_paths.join(', ')}</span>
          )}
          {/* What was running at the time. An agent is an identity; the
              client and the model it used are properties of one connection
              and may be different tomorrow. */}
          {(event.client ?? event.model) && (
            <span className="text-xs text-muted-foreground">
              {[event.client, event.provider, event.model].filter(Boolean).join(' · ')}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
