import type { AgentId } from '@knoverge/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { adminApi } from '../api/admin.ts';
import { ErrorNotice } from '../components/ErrorNotice.tsx';
import { Field } from '../components/Field.tsx';

const AGENTS_KEY = ['admin', 'agents'] as const;

function CredentialList({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
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
    <table>
      <thead>
        <tr>
          <th scope="col">{t('agents.credential')}</th>
          <th scope="col">{t('agents.credential_state')}</th>
          <th scope="col">{t('agents.last_used')}</th>
          <th scope="col" />
        </tr>
      </thead>
      <tbody>
        {query.data.credentials.map((credential) => {
          const expired =
            credential.expires_at !== null && new Date(credential.expires_at) <= new Date();
          const state = credential.revoked_at ? 'revoked' : expired ? 'expired' : 'active';
          return (
            <tr key={credential.id}>
              <td>
                <code>{credential.token_prefix}</code> {credential.label ?? ''}
              </td>
              <td>{t(`agents.states.${state}`)}</td>
              <td>
                {credential.last_used_at
                  ? new Date(credential.last_used_at).toLocaleString()
                  : t('agents.never_used')}
              </td>
              <td>
                {state === 'active' && (
                  <button type="button" onClick={() => revoke.mutate(credential.id)}>
                    {t('agents.revoke')}
                  </button>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function AgentsPage() {
  const { t } = useTranslation();
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
  const disable = useMutation({
    mutationFn: (agentId: AgentId) =>
      adminApi.agents.update({ agent_id: agentId, status: 'disabled' }),
    onSuccess: refresh,
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate();
  };

  return (
    <>
      <section className="card" aria-labelledby="agents-title">
        <h2 id="agents-title">{t('agents.title')}</h2>
        <p>{t('agents.intro')}</p>
        {agents.isPending && <p role="status">{t('common.loading')}</p>}
        {agents.isError && <ErrorNotice error={agents.error} />}
        {agents.data?.agents.length === 0 && <p>{t('agents.empty')}</p>}
        {agents.data && agents.data.agents.length > 0 && (
          <table>
            <thead>
              <tr>
                <th scope="col">{t('agents.name')}</th>
                <th scope="col">{t('agents.trust_tier')}</th>
                <th scope="col">{t('agents.status')}</th>
                <th scope="col">{t('agents.credentials')}</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {agents.data.agents.map((agent) => (
                <tr key={agent.id}>
                  <td>
                    {agent.name}
                    {agent.client_type && (
                      <>
                        {' '}
                        <code>{agent.client_type}</code>
                      </>
                    )}
                  </td>
                  <td>{t(`agents.tiers.${agent.trust_tier}`)}</td>
                  <td>{t(`agents.statuses.${agent.status}`)}</td>
                  <td>{agent.active_credentials}</td>
                  <td>
                    <button
                      type="button"
                      onClick={() => setExpanded(expanded === agent.id ? null : agent.id)}
                    >
                      {t('agents.manage')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {expanded && (
        <section className="card" aria-labelledby="agent-detail-title">
          <h3 id="agent-detail-title">
            {agents.data?.agents.find((a) => a.id === expanded)?.name ?? ''}
          </h3>
          {issuedToken?.agentId === expanded && (
            <div className="notice" role="alert">
              <p>
                <strong>{t('agents.token_once')}</strong>
              </p>
              <pre>
                <code>{issuedToken.token}</code>
              </pre>
              <button type="button" onClick={() => setIssuedToken(null)}>
                {t('agents.hide_token')}
              </button>
            </div>
          )}
          <p>
            <button type="button" onClick={() => issue.mutate(expanded)} disabled={issue.isPending}>
              {t('agents.issue_token')}
            </button>{' '}
            <button
              type="button"
              onClick={() => disable.mutate(expanded)}
              disabled={disable.isPending}
            >
              {t('agents.disable')}
            </button>
          </p>
          <ErrorNotice error={issue.error ?? disable.error} />
          <CredentialList agentId={expanded} />
        </section>
      )}

      <section className="card" aria-labelledby="new-agent-title">
        <h3 id="new-agent-title">{t('agents.new')}</h3>
        <form onSubmit={submit}>
          <fieldset disabled={create.isPending}>
            <Field label={t('agents.name')}>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={120}
              />
            </Field>
            <Field label={t('agents.client_type')} hint={t('agents.client_type_hint')}>
              <input value={clientType} onChange={(e) => setClientType(e.target.value)} />
            </Field>
            <Field label={t('agents.trust_tier')} hint={t(`agents.tier_hints.${trustTier}`)}>
              <select
                value={trustTier}
                onChange={(e) => setTrustTier(e.target.value as typeof trustTier)}
              >
                <option value="read_only">{t('agents.tiers.read_only')}</option>
                <option value="propose">{t('agents.tiers.propose')}</option>
                <option value="trusted">{t('agents.tiers.trusted')}</option>
              </select>
            </Field>
          </fieldset>
          <ErrorNotice error={create.error} />
          <button type="submit" disabled={create.isPending}>
            {create.isPending ? t('common.working') : t('agents.create')}
          </button>
        </form>
      </section>
    </>
  );
}
