import type { AgentId, AgentSummary } from '@knoverge/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Power } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { AGENTS_KEY } from '@/lib/query-keys';
import { relativeTime } from '@/lib/relative-time';
import { adminApi } from '../../api/admin.ts';
import { ErrorNotice } from '../ErrorNotice.tsx';
import { AgentActivity } from './AgentActivity.tsx';
import { connectionOf } from './connection.ts';
import { IssueCredential } from './IssueCredential.tsx';

/**
 * One agent as an object: what it may do, what it holds, and how to stop it.
 *
 * The trust tier and the credentials are the whole of an agent's power, and
 * neither fitted on the row of a table. Revoking a credential and lowering a
 * tier are the two things somebody opens this to do in a hurry.
 */
export function AgentDetails({ agent }: { agent: AgentSummary }) {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const [issuing, setIssuing] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const refresh = () => client.invalidateQueries({ queryKey: AGENTS_KEY });
  const connection = connectionOf(agent);

  const setStatus = useMutation({
    mutationFn: (status: 'active' | 'disabled') =>
      adminApi.agents.update({ agent_id: agent.id, status }),
    onSuccess: async () => {
      setDisabling(false);
      await refresh();
    },
  });
  const setTier = useMutation({
    mutationFn: (tier: AgentSummary['trust_tier']) =>
      adminApi.agents.update({ agent_id: agent.id, trust_tier: tier }),
    onSuccess: refresh,
  });

  return (
    <div className="grid content-start gap-5 p-4 sm:p-6">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={connection === 'active' ? 'default' : 'outline'}>
          {t(`agents.connection.${connection}`)}
        </Badge>
        {agent.client_type && (
          <Badge variant="outline" className="font-mono font-normal">
            {agent.client_type}
          </Badge>
        )}
      </div>
      {agent.description && <p className="text-sm text-muted-foreground">{agent.description}</p>}

      <ErrorNotice error={setStatus.error ?? setTier.error} />

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">{t('agents.tab_overview')}</TabsTrigger>
          <TabsTrigger value="access">{t('agents.tab_access')}</TabsTrigger>
          <TabsTrigger value="credentials">
            {t('agents.tab_credentials')}
            {agent.active_credentials > 0 && (
              <span className="ml-1.5 font-mono text-xs text-muted-foreground">
                {agent.active_credentials}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="activity">{t('agents.tab_activity')}</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <dl className="grid gap-2 text-sm sm:grid-cols-[10rem_1fr]">
            <dt className="text-muted-foreground">{t('agents.access')}</dt>
            <dd>{t(`agents.tiers.${agent.trust_tier}`)}</dd>
            <dt className="text-muted-foreground">{t('agents.last_seen')}</dt>
            <dd>
              {agent.last_seen_at
                ? relativeTime(agent.last_seen_at, i18n.language)
                : t('agents.never_seen')}
            </dd>
            <dt className="text-muted-foreground">{t('agents.created')}</dt>
            <dd>{new Date(agent.created_at).toLocaleDateString(i18n.language)}</dd>
            <dt className="text-muted-foreground">{t('agents.tab_credentials')}</dt>
            <dd>{t('agents.credential_count', { count: agent.active_credentials })}</dd>
            {/* An id, because this is the thing a policy rule and a permission
                grant are written against. */}
            <dt className="text-muted-foreground">{t('agents.actor')}</dt>
            <dd className="font-mono text-xs break-all">{agent.actor_id}</dd>
          </dl>
          {connection === 'never' && (
            <p className="rounded-md border border-dashed border-border p-3 text-sm text-muted-foreground">
              {t('agents.never_connected_hint')}
            </p>
          )}
        </TabsContent>

        <TabsContent value="access">
          <Field label={t('agents.access')} hint={t(`agents.tier_hints.${agent.trust_tier}`)}>
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

          {/* In the model and not yet on this screen. Permission grants
              already carry a category and whether they reach its descendants;
              what is missing is somewhere to say so, and that is its own
              screen rather than a control smuggled in here. */}
          <div className="grid gap-1.5 rounded-lg border border-dashed border-border p-4 opacity-60">
            <h4 className="flex items-center gap-2 text-sm font-medium">
              {t('agents.scope')}
              <Badge variant="outline" className="font-normal text-muted-foreground">
                {t('settings.not_yet')}
              </Badge>
            </h4>
            <p className="text-sm text-muted-foreground">{t('agents.scope_hint')}</p>
          </div>

          <div className="grid gap-2">
            <h4 className="text-sm font-medium">{t('agents.stopping')}</h4>
            {agent.status === 'disabled' ? (
              <>
                <p className="text-sm text-muted-foreground">{t('agents.disabled_hint')}</p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-fit"
                  onClick={() => setStatus.mutate('active')}
                  disabled={setStatus.isPending}
                >
                  <Power aria-hidden="true" className="size-4" />
                  {t('agents.enable')}
                </Button>
              </>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">{t('agents.disable_hint')}</p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-fit text-destructive"
                  onClick={() => setDisabling(true)}
                  disabled={setStatus.isPending}
                >
                  <Power aria-hidden="true" className="size-4" />
                  {t('agents.disable')}
                </Button>
              </>
            )}
          </div>
        </TabsContent>

        <TabsContent value="credentials">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground">{t('agents.credentials_hint')}</p>
            <Button
              type="button"
              size="sm"
              onClick={() => setIssuing(true)}
              disabled={agent.status !== 'active'}
            >
              <KeyRound aria-hidden="true" className="size-4" />
              {t('agents.issue_token')}
            </Button>
          </div>
          <CredentialList agentId={agent.id} />
        </TabsContent>

        <TabsContent value="activity">
          <AgentActivity actorId={agent.actor_id} />
        </TabsContent>
      </Tabs>

      <IssueCredential
        agent={agent}
        open={issuing}
        onOpenChange={setIssuing}
        onIssued={async () => {
          await client.invalidateQueries({ queryKey: ['admin', 'credentials', agent.id] });
          await refresh();
        }}
      />

      <ConfirmDisable
        agent={agent}
        open={disabling}
        onOpenChange={setDisabling}
        onConfirm={() => setStatus.mutate('disabled')}
        busy={setStatus.isPending}
      />
    </div>
  );
}

/**
 * Turning an agent off, with what that costs said first.
 *
 * Disabling revokes every credential the agent holds, and a client that was
 * working stops within the minute. Where there is something to lose, the name
 * is typed: a confirmation somebody can dismiss by reflex is not one.
 */
function ConfirmDisable({
  agent,
  open,
  onOpenChange,
  onConfirm,
  busy,
}: {
  agent: AgentSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  busy: boolean;
}) {
  const { t } = useTranslation();
  const [typed, setTyped] = useState('');
  // Only where something is actually revoked. Asking somebody to type a name
  // to turn off an agent that holds nothing teaches them to type names.
  const needsName = agent.active_credentials > 0;
  const ready = !needsName || typed.trim() === agent.name;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setTyped('');
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('agents.disable_title', { name: agent.name })}</DialogTitle>
          <DialogDescription>{t('agents.disable_intro')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <p className="text-sm">
            {t('agents.disable_revokes', { count: agent.active_credentials })}
          </p>
          <p className="text-sm text-muted-foreground">{t('agents.disable_keeps')}</p>
          {needsName && (
            <Field label={t('agents.disable_confirm', { name: agent.name })}>
              <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
            </Field>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={onConfirm}
              disabled={!ready || busy}
            >
              {busy ? t('common.working') : t('agents.disable')}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
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
