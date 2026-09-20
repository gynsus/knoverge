import type { AgentId, AgentSummary } from '@knoverge/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { adminApi } from '../api/admin.ts';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ErrorNotice } from '../components/ErrorNotice.tsx';

const AGENTS_KEY = ['admin', 'agents'] as const;

function CredentialList({ agentId }: { agentId: string }) {
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
  if (query.data.credentials.length === 0) return <p>{t('agents.no_credentials')}</p>;

  return (
    <>
      <ErrorNotice error={revoke.error} />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('agents.credential')}</TableHead>
            <TableHead>{t('agents.credential_state')}</TableHead>
            <TableHead>{t('agents.last_used')}</TableHead>
            <TableHead />
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

export function AgentsPage() {
  const { t } = useTranslation();
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const lastTrigger = useRef<HTMLButtonElement | null>(null);
  const client = useQueryClient();
  const [name, setName] = useState('');
  const [clientType, setClientType] = useState('');
  const [trustTier, setTrustTier] = useState<'read_only' | 'propose' | 'trusted'>('propose');
  const [expanded, setExpanded] = useState<AgentId | null>(null);
  const [issuedToken, setIssuedToken] = useState<{ agentId: string; token: string } | null>(null);

  const agents = useQuery({
    queryKey: AGENTS_KEY,
    queryFn: ({ signal }) => adminApi.agents.list(signal),
  });
  const refresh = () => client.invalidateQueries({ queryKey: AGENTS_KEY });

  const create = useMutation({
    mutationFn: () =>
      adminApi.agents.create({
        name,
        trust_tier: trustTier,
        ...(clientType ? { client_type: clientType } : {}),
      }),
    onSuccess: async () => {
      setName('');
      setClientType('');
      await refresh();
    },
  });
  const issue = useMutation({
    mutationFn: (agentId: AgentId) => adminApi.agents.issue({ agent_id: agentId }),
    onSuccess: async (result, agentId: AgentId) => {
      setIssuedToken({ agentId, token: result.token });
      await client.invalidateQueries({ queryKey: ['admin', 'credentials', agentId] });
      await refresh();
    },
  });
  const setStatus = useMutation({
    mutationFn: ({ agentId, status }: { agentId: AgentId; status: 'active' | 'disabled' }) =>
      adminApi.agents.update({ agent_id: agentId, status }),
    onSuccess: refresh,
  });
  const setTier = useMutation({
    mutationFn: ({ agentId, tier }: { agentId: AgentId; tier: AgentSummary['trust_tier'] }) =>
      adminApi.agents.update({ agent_id: agentId, trust_tier: tier }),
    onSuccess: refresh,
  });

  // The panel appears below the table, so without this a keyboard or screen
  // reader user is left where they were and has to hunt for what opened.
  useEffect(() => {
    if (expanded) detailHeading.current?.focus();
    else lastTrigger.current?.focus();
  }, [expanded]);

  const current = agents.data?.agents.find((a) => a.id === expanded);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate();
  };

  return (
    <>
      <Card aria-labelledby="agents-title" className="grid gap-3 p-4 sm:p-6">
        <CardTitle id="agents-title">{t('agents.title')}</CardTitle>
        <p>{t('agents.intro')}</p>
        {agents.isPending && <p role="status">{t('common.loading')}</p>}
        {agents.isError && <ErrorNotice error={agents.error} />}
        {agents.data?.agents.length === 0 && <p>{t('agents.empty')}</p>}
        {agents.data && agents.data.agents.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('agents.name')}</TableHead>
                <TableHead>{t('agents.trust_tier')}</TableHead>
                <TableHead>{t('agents.status')}</TableHead>
                <TableHead>{t('agents.credentials')}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {agents.data.agents.map((agent) => (
                <TableRow key={agent.id}>
                  <TableCell label={t('agents.name')}>
                    {agent.name}
                    {agent.client_type && (
                      <>
                        {' '}
                        <code>{agent.client_type}</code>
                      </>
                    )}
                  </TableCell>
                  <TableCell label={t('agents.trust_tier')}>
                    {t(`agents.tiers.${agent.trust_tier}`)}
                  </TableCell>
                  <TableCell label={t('agents.status')}>
                    {t(`agents.statuses.${agent.status}`)}
                  </TableCell>
                  <TableCell label={t('agents.credentials')}>{agent.active_credentials}</TableCell>
                  <TableCell label={t('common.actions')}>
                    <Button
                      type="button"
                      aria-expanded={expanded === agent.id}
                      onClick={(event) => {
                        lastTrigger.current = event.currentTarget;
                        setExpanded(expanded === agent.id ? null : agent.id);
                      }}
                    >
                      {t('agents.manage')}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {expanded && (
        <Card aria-labelledby="agent-detail-title" className="grid gap-3 p-4 sm:p-6">
          <CardTitle id="agent-detail-title" tabIndex={-1} ref={detailHeading}>
            {current?.name ?? ''}
          </CardTitle>
          {issuedToken?.agentId === expanded && (
            <div className="notice">
              <p role="status">
                <strong>{t('agents.token_once')}</strong>
              </p>
              {/* Outside the live region: an assertive announcement would read
                  the secret out loud, and it is the instruction that matters. */}
              <pre>
                <code>{issuedToken.token}</code>
              </pre>
              <Button type="button" onClick={() => setIssuedToken(null)}>
                {t('agents.hide_token')}
              </Button>
            </div>
          )}
          <Field label={t('agents.trust_tier')} hint={t('agents.tier_change_hint')}>
            <Select
              value={current?.trust_tier ?? 'propose'}
              onChange={(e) =>
                setTier.mutate({
                  agentId: expanded,
                  tier: e.target.value as AgentSummary['trust_tier'],
                })
              }
              disabled={setTier.isPending}
            >
              <option value="read_only">{t('agents.tiers.read_only')}</option>
              <option value="propose">{t('agents.tiers.propose')}</option>
              <option value="trusted">{t('agents.tiers.trusted')}</option>
            </Select>
          </Field>
          <p>
            <Button
              type="button"
              onClick={() => issue.mutate(expanded)}
              disabled={issue.isPending || current?.status !== 'active'}
            >
              {t('agents.issue_token')}
            </Button>{' '}
            {current?.status === 'disabled' ? (
              // A disabled agent could never be brought back from the browser,
              // although the contract has always allowed it.
              <Button
                type="button"
                onClick={() => setStatus.mutate({ agentId: expanded, status: 'active' })}
                disabled={setStatus.isPending}
              >
                {t('agents.enable')}
              </Button>
            ) : (
              <Button
                type="button"
                onClick={() => setStatus.mutate({ agentId: expanded, status: 'disabled' })}
                disabled={setStatus.isPending}
              >
                {t('agents.disable')}
              </Button>
            )}
          </p>
          <p>
            <small>{t('agents.disable_hint')}</small>
          </p>
          <ErrorNotice error={issue.error ?? setStatus.error ?? setTier.error} />
          <CredentialList agentId={expanded} />
        </Card>
      )}

      <Card aria-labelledby="new-agent-title" className="grid gap-3 p-4 sm:p-6">
        <CardTitle id="new-agent-title">{t('agents.new')}</CardTitle>
        <form onSubmit={submit}>
          <fieldset disabled={create.isPending} className="grid gap-4 border-0 p-0">
            <Field label={t('agents.name')}>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={120}
              />
            </Field>
            <Field label={t('agents.client_type')} hint={t('agents.client_type_hint')}>
              <Input value={clientType} onChange={(e) => setClientType(e.target.value)} />
            </Field>
            <Field label={t('agents.trust_tier')} hint={t(`agents.tier_hints.${trustTier}`)}>
              <Select
                value={trustTier}
                onChange={(e) => setTrustTier(e.target.value as typeof trustTier)}
              >
                <option value="read_only">{t('agents.tiers.read_only')}</option>
                <option value="propose">{t('agents.tiers.propose')}</option>
                <option value="trusted">{t('agents.tiers.trusted')}</option>
              </Select>
            </Field>
          </fieldset>
          <ErrorNotice error={create.error} />
          <Button type="submit" disabled={create.isPending}>
            {create.isPending ? t('common.working') : t('agents.create')}
          </Button>
        </form>
      </Card>
    </>
  );
}
