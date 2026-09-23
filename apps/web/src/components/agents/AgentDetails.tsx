import type { AgentId, AgentSummary } from '@knoverge/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Power } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Select } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { AGENTS_KEY } from '@/lib/query-keys';
import { adminApi } from '../../api/admin.ts';
import { ErrorNotice } from '../ErrorNotice.tsx';

/**
 * One agent as an object: what it may do, what it holds, and how to stop it.
 *
 * The trust tier and the credentials are the whole of an agent's power, and
 * neither fitted on the row of a table. Revoking a credential and lowering a
 * tier are the two things somebody opens this to do in a hurry.
 */
export function AgentDetails({ agent }: { agent: AgentSummary }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [issued, setIssued] = useState<string | null>(null);
  const refresh = () => client.invalidateQueries({ queryKey: AGENTS_KEY });

  const issue = useMutation({
    mutationFn: () => adminApi.agents.issue({ agent_id: agent.id }),
    onSuccess: async (result) => {
      setIssued(result.token);
      await client.invalidateQueries({ queryKey: ['admin', 'credentials', agent.id] });
      await refresh();
    },
  });
  const setStatus = useMutation({
    mutationFn: (status: 'active' | 'disabled') =>
      adminApi.agents.update({ agent_id: agent.id, status }),
    onSuccess: refresh,
  });
  const setTier = useMutation({
    mutationFn: (tier: AgentSummary['trust_tier']) =>
      adminApi.agents.update({ agent_id: agent.id, trust_tier: tier }),
    onSuccess: refresh,
  });

  return (
    <div className="grid content-start gap-5 p-4 sm:p-6">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={agent.status === 'active' ? 'default' : 'outline'}>
          {t(`agents.statuses.${agent.status}`)}
        </Badge>
        {agent.client_type && (
          <Badge variant="outline" className="font-mono font-normal">
            {agent.client_type}
          </Badge>
        )}
      </div>

      {issued && (
        <div className="grid gap-2 rounded-md border-2 border-primary p-3">
          <p role="status">
            <strong>{t('agents.token_once')}</strong>
          </p>
          {/* Outside the live region: an assertive announcement would read the
              secret out loud, and it is the instruction that matters. The
              scroller matters too: a token is one unbreakable string, and
              without it the panel grows past the width of a phone. */}
          <pre className="overflow-x-auto rounded bg-muted p-2 text-xs">
            <code>{issued}</code>
          </pre>
          <Button type="button" onClick={() => setIssued(null)}>
            {t('agents.hide_token')}
          </Button>
        </div>
      )}

      <Field label={t('agents.trust_tier')} hint={t('agents.tier_change_hint')}>
        <Select
          value={agent.trust_tier}
          onChange={(e) => setTier.mutate(e.target.value as AgentSummary['trust_tier'])}
          disabled={setTier.isPending}
        >
          <option value="read_only">{t('agents.tiers.read_only')}</option>
          <option value="propose">{t('agents.tiers.propose')}</option>
          <option value="trusted">{t('agents.tiers.trusted')}</option>
        </Select>
      </Field>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          onClick={() => issue.mutate()}
          disabled={issue.isPending || agent.status !== 'active'}
        >
          <KeyRound aria-hidden="true" className="size-4" />
          {t('agents.issue_token')}
        </Button>
        {/* A disabled agent could never be brought back from the browser,
            although the contract has always allowed it. */}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setStatus.mutate(agent.status === 'disabled' ? 'active' : 'disabled')}
          disabled={setStatus.isPending}
        >
          <Power aria-hidden="true" className="size-4" />
          {agent.status === 'disabled' ? t('agents.enable') : t('agents.disable')}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t('agents.disable_hint')}</p>
      <ErrorNotice error={issue.error ?? setStatus.error ?? setTier.error} />

      <Separator />

      <section className="grid gap-2">
        <h4 className="text-sm font-medium">{t('agents.credentials')}</h4>
        <CredentialList agentId={agent.id} />
      </section>
    </div>
  );
}

function CredentialList({ agentId }: { agentId: AgentId }) {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const key = ['admin', 'credentials', agentId] as const;
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => adminApi.agents.credentials(agentId, signal),
  });
  const revoke = useMutation({
    mutationFn: (credentialId: string) => adminApi.agents.revoke(credentialId),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: key });
      await client.invalidateQueries({ queryKey: AGENTS_KEY });
    },
  });

  if (query.isPending) return <p role="status">{t('common.loading')}</p>;
  if (query.isError) return <ErrorNotice error={query.error} />;
  if (query.data.credentials.length === 0)
    return <p className="text-sm text-muted-foreground">{t('agents.no_credentials')}</p>;

  return (
    <>
      <ErrorNotice error={revoke.error} />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('agents.credential')}</TableHead>
            <TableHead>{t('agents.credential_state')}</TableHead>
            <TableHead>{t('agents.last_used')}</TableHead>
            <TableHead>
              <span className="sr-only">{t('common.actions')}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {query.data.credentials.map((credential) => {
            const expired =
              credential.expires_at !== null && new Date(credential.expires_at) <= new Date();
            const state = credential.revoked_at ? 'revoked' : expired ? 'expired' : 'active';
            return (
              <TableRow key={credential.id}>
                <TableCell label={t('agents.credential')}>
                  <code>{credential.token_prefix}</code> {credential.label ?? ''}
                </TableCell>
                <TableCell label={t('agents.credential_state')}>
                  {t(`agents.states.${state}`)}
                </TableCell>
                <TableCell label={t('agents.last_used')}>
                  {credential.last_used_at
                    ? new Date(credential.last_used_at).toLocaleString(i18n.language)
                    : t('agents.never_used')}
                </TableCell>
                <TableCell label={t('common.actions')}>
                  {state === 'active' && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => revoke.mutate(credential.id)}
                      disabled={revoke.isPending}
                    >
                      {t('agents.revoke')}
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </>
  );
}
