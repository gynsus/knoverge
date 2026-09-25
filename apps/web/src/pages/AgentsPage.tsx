import type { AgentSummary } from '@knoverge/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Search, X } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';

import { Button } from '@/components/ui/button';
import { Field, FieldSet } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Table, TableBody, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { AGENTS_KEY } from '@/lib/query-keys';
import { adminApi } from '../api/admin.ts';
import { AgentDetails } from '../components/agents/AgentDetails.tsx';
import { AgentRow } from '../components/agents/AgentRow.tsx';
import { connectionOf, type Connection } from '../components/agents/connection.ts';
import { ErrorNotice } from '../components/ErrorNotice.tsx';

type Tier = AgentSummary['trust_tier'];

/**
 * Who reaches this workspace that is not a person.
 *
 * A table, because a list of agents is scanned rather than read, and the
 * agent itself in a drawer: its tier and its credentials are the whole of its
 * power and neither fitted on a row. Registering one is a drawer too, at
 * `?new`, so a reload does not lose a half-filled form.
 */
export function AgentsPage() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [inspecting, setInspecting] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [connection, setConnection] = useState<'all' | Connection>('all');
  const [access, setAccess] = useState<'all' | Tier>('all');
  const [clientType, setClientType] = useState('all');

  const agents = useQuery({
    queryKey: AGENTS_KEY,
    queryFn: ({ signal }) => adminApi.agents.list(signal),
  });
  const all = useMemo(() => agents.data?.agents ?? [], [agents.data]);
  const clients = useMemo(
    () => [...new Set(all.flatMap((a) => (a.client_type ? [a.client_type] : [])))].sort(),
    [all],
  );
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return all.filter(
      (agent) =>
        (needle === '' ||
          agent.name.toLowerCase().includes(needle) ||
          (agent.description ?? '').toLowerCase().includes(needle) ||
          (agent.client_type ?? '').toLowerCase().includes(needle)) &&
        (connection === 'all' || connectionOf(agent) === connection) &&
        (access === 'all' || agent.trust_tier === access) &&
        (clientType === 'all' || agent.client_type === clientType),
    );
  }, [all, query, connection, access, clientType]);
  const filtered = query !== '' || connection !== 'all' || access !== 'all' || clientType !== 'all';
  const reset = () => {
    setQuery('');
    setConnection('all');
    setAccess('all');
    setClientType('all');
  };
  const inspected = all.find((a) => a.id === inspecting) ?? null;
  const creating = params.has('new');
  const closeForm = () => {
    const next = new URLSearchParams(params);
    next.delete('new');
    setParams(next, { replace: true });
  };

  return (
    <div className="grid gap-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="grid gap-1.5">
          <h2 className="text-2xl font-semibold tracking-tight">{t('agents.title')}</h2>
          <p className="max-w-2xl text-sm text-muted-foreground">{t('agents.intro')}</p>
        </div>
        <Button type="button" className="shrink-0" onClick={() => setParams({ new: '' })}>
          <Plus aria-hidden="true" className="size-4" />
          {t('agents.new')}
        </Button>
      </div>

      {all.length > 0 && (
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="relative min-w-0 flex-1 lg:max-w-md">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label={t('agents.search')}
              placeholder={t('agents.search')}
              className="pr-9 pl-9"
            />
            {query !== '' && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label={t('agents.search_clear')}
                className="absolute top-1/2 right-3 -translate-y-1/2 rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <X aria-hidden="true" className="size-4" />
              </button>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3 sm:flex">
            <Select
              value={connection}
              onChange={(e) => setConnection(e.target.value as 'all' | Connection)}
              aria-label={t('agents.filter_status')}
              className="sm:w-44"
            >
              <option value="all">{t('agents.all_statuses')}</option>
              <option value="active">{t('agents.connection.active')}</option>
              <option value="never">{t('agents.connection.never')}</option>
              <option value="disabled">{t('agents.connection.disabled')}</option>
            </Select>
            <Select
              value={access}
              onChange={(e) => setAccess(e.target.value as 'all' | Tier)}
              aria-label={t('agents.filter_access')}
              className="sm:w-48"
            >
              <option value="all">{t('agents.all_access')}</option>
              <option value="read_only">{t('agents.tiers.read_only')}</option>
              <option value="propose">{t('agents.tiers.propose')}</option>
              <option value="trusted">{t('agents.tiers.trusted')}</option>
            </Select>
            {clients.length > 1 && (
              <Select
                value={clientType}
                onChange={(e) => setClientType(e.target.value)}
                aria-label={t('agents.filter_client')}
                className="sm:w-44"
              >
                <option value="all">{t('agents.all_clients')}</option>
                {clients.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </Select>
            )}
          </div>
        </div>
      )}

      <ErrorNotice error={agents.isError ? agents.error : undefined} />
      {agents.isPending && <p role="status">{t('common.loading')}</p>}

      {agents.data && all.length > 0 && (
        <div className="flex min-h-8 items-center justify-between gap-2">
          <p role="status" className="text-sm text-muted-foreground">
            {t('agents.count', { count: visible.length })}
          </p>
          {filtered && visible.length > 0 && (
            <Button variant="ghost" size="sm" onClick={reset} className="text-muted-foreground">
              {t('agents.reset_filters')}
            </Button>
          )}
        </div>
      )}

      {agents.data &&
        (visible.length === 0 ? (
          <div className="grid min-h-40 place-items-center gap-3 rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            <p>{filtered ? t('agents.empty_filtered') : t('agents.empty')}</p>
            {filtered && (
              <Button variant="outline" size="sm" onClick={reset}>
                {t('agents.reset_filters')}
              </Button>
            )}
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('agents.agent')}</TableHead>
                <TableHead>{t('agents.access')}</TableHead>
                <TableHead>{t('agents.client_type')}</TableHead>
                <TableHead>{t('agents.status')}</TableHead>
                <TableHead>{t('agents.last_seen')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((agent) => (
                <AgentRow key={agent.id} agent={agent} onOpen={() => setInspecting(agent.id)} />
              ))}
            </TableBody>
          </Table>
        ))}

      <Sheet open={inspected !== null} onOpenChange={(open) => !open && setInspecting(null)}>
        <SheetContent side="right" className="w-full gap-0 overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>{inspected?.name ?? t('agents.title')}</SheetTitle>
            <SheetDescription className="sr-only">{t('agents.intro')}</SheetDescription>
          </SheetHeader>
          {inspected && <AgentDetails agent={inspected} />}
        </SheetContent>
      </Sheet>

      <Sheet open={creating} onOpenChange={(open) => !open && closeForm()}>
        <SheetContent side="right" className="w-full gap-0 overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>{t('agents.new')}</SheetTitle>
            <SheetDescription>{t('agents.new_intro')}</SheetDescription>
          </SheetHeader>
          <NewAgentForm
            key={String(creating)}
            onDone={async () => {
              await client.invalidateQueries({ queryKey: AGENTS_KEY });
              closeForm();
            }}
            onCancel={closeForm}
          />
        </SheetContent>
      </Sheet>
    </div>
  );
}

function NewAgentForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [clientType, setClientType] = useState('');
  const [trustTier, setTrustTier] = useState<Tier>('propose');

  const create = useMutation({
    mutationFn: () =>
      adminApi.agents.create({
        name,
        trust_tier: trustTier,
        ...(clientType ? { client_type: clientType } : {}),
      }),
    onSuccess: onDone,
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate();
  };

  return (
    <form onSubmit={submit} className="grid gap-4 p-4">
      <FieldSet disabled={create.isPending}>
        <Field label={t('agents.name')}>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={120}
            autoFocus
          />
        </Field>
        <Field label={t('agents.client_type')} hint={t('agents.client_type_hint')}>
          <Input value={clientType} onChange={(e) => setClientType(e.target.value)} />
        </Field>
        <Field label={t('agents.trust_tier')} hint={t(`agents.tier_hints.${trustTier}`)}>
          <Select value={trustTier} onChange={(e) => setTrustTier(e.target.value as Tier)}>
            <option value="read_only">{t('agents.tiers.read_only')}</option>
            <option value="propose">{t('agents.tiers.propose')}</option>
            <option value="trusted">{t('agents.tiers.trusted')}</option>
          </Select>
        </Field>
      </FieldSet>
      <ErrorNotice error={create.error} />
      <SheetFooter className="px-0">
        <Button type="button" variant="outline" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" disabled={create.isPending || name.trim() === ''}>
          {create.isPending ? t('common.working') : t('agents.create')}
        </Button>
      </SheetFooter>
    </form>
  );
}
