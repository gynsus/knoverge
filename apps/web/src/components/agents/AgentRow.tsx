import type { AgentSummary } from '@knoverge/contracts';
import { useTranslation } from 'react-i18next';

import { Badge } from '@/components/ui/badge';
import { TableCell, TableRow } from '@/components/ui/table';
import { relativeTime } from '@/lib/relative-time';
import { cn } from '@/lib/utils';
import { connectionOf } from './connection.ts';

/**
 * One agent, as a row somebody scans.
 *
 * The columns answer the questions asked of a list of agents: who is this,
 * what may it do, what is it, is it working, and when did it last do
 * anything. How many tokens it holds is a detail of the last of those and
 * sits under the name rather than taking a column from them.
 */
export function AgentRow({ agent, onOpen }: { agent: AgentSummary; onOpen: () => void }) {
  const { t, i18n } = useTranslation();
  const connection = connectionOf(agent);

  return (
    <TableRow onClick={onOpen} className="cursor-pointer transition-colors hover:bg-muted/60">
      <TableCell label={t('agents.agent')}>
        <button
          type="button"
          onClick={(event) => {
            // The row carries the click; this is here so a keyboard reaches
            // the same place, and so the name is what a screen reader lands on.
            event.stopPropagation();
            onOpen();
          }}
          className="text-left font-medium underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {agent.name}
        </button>
        {agent.description && (
          <span className="block truncate text-xs text-muted-foreground">{agent.description}</span>
        )}
        <span className="block text-xs text-muted-foreground">
          {t('agents.credential_count', { count: agent.active_credentials })}
        </span>
      </TableCell>
      <TableCell label={t('agents.access')}>{t(`agents.tiers.${agent.trust_tier}`)}</TableCell>
      <TableCell label={t('agents.client_type')}>
        {agent.client_type ?? <span className="text-muted-foreground">—</span>}
      </TableCell>
      <TableCell label={t('agents.status')}>
        <Badge
          variant={connection === 'active' ? 'default' : 'outline'}
          className={cn(connection === 'never' && 'text-muted-foreground')}
        >
          {t(`agents.connection.${connection}`)}
        </Badge>
      </TableCell>
      <TableCell label={t('agents.last_seen')}>
        {agent.last_seen_at ? (
          relativeTime(agent.last_seen_at, i18n.language)
        ) : (
          <span className="text-muted-foreground">{t('agents.never_seen')}</span>
        )}
      </TableCell>
    </TableRow>
  );
}
