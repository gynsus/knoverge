import type { ActorSummary, EventSummary } from '@knoverge/contracts';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { Badge } from '@/components/ui/badge';
import { relativeTime } from '@/lib/relative-time';

/**
 * Where an event leads, when it leads anywhere.
 *
 * An event names an object and a feed that stops at the name makes a reader
 * copy an id somewhere else. A category has no address of its own — the tree is
 * one screen — so that one goes to the tree.
 */
function addressOf(event: EventSummary): string | null {
  switch (event.object_type) {
    case 'knowledge_item':
      return `/knowledge?item=${encodeURIComponent(event.object_id)}`;
    case 'proposal':
      return `/review?proposal=${encodeURIComponent(event.object_id)}`;
    case 'category':
      return '/taxonomy';
    default:
      return null;
  }
}

/**
 * One row of the ledger.
 *
 * What happened, to what, by whom and when. Never the knowledge itself: the
 * ledger holds ids, hashes, actor context and safe metadata, and has no text to
 * show even if this wanted to (rule 4).
 */
export function EventRow({
  event,
  actors,
}: {
  event: EventSummary;
  /** Display names by actor id, so a row says who rather than which id. */
  actors: Map<string, ActorSummary>;
}) {
  const { t, i18n } = useTranslation();
  const actor = actors.get(event.actor_id);
  const address = addressOf(event);
  const label = t(`events.types.${event.event_type}`, { defaultValue: event.event_type });

  return (
    <li className="grid gap-1 border-b border-border py-3 last:border-b-0">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <Badge variant="outline" className="font-normal">
          {label}
        </Badge>
        {address ? (
          <Link
            to={address}
            className="min-w-0 truncate font-mono text-xs underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {event.object_id}
          </Link>
        ) : (
          <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
            {event.object_id}
          </span>
        )}
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
          {relativeTime(event.created_at, i18n.language)}
        </span>
      </div>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span>{actor?.display_name ?? t('ledger.unknown_actor')}</span>
        {event.category_paths.length > 0 && <span>· {event.category_paths.join(', ')}</span>}
        {/* What was running at the time. An agent is an identity; the client
            and the model it used are properties of one connection. */}
        {(event.client ?? event.model) && (
          <span>· {[event.client, event.provider, event.model].filter(Boolean).join(' · ')}</span>
        )}
        {/* The position in the chain, which is what makes it a ledger rather
            than a log: sequences are per workspace and never reused. */}
        <span className="ml-auto font-mono">#{event.sequence}</span>
      </div>
    </li>
  );
}
