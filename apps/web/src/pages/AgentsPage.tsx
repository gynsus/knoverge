import type { AgentSummary } from '@knoverge/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';

import { Badge } from '@/components/ui/badge';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { AGENTS_KEY } from '@/lib/query-keys';
import { adminApi } from '../api/admin.ts';
import { AgentDetails } from '../components/agents/AgentDetails.tsx';
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

  const agents = useQuery({
    queryKey: AGENTS_KEY,
    queryFn: ({ signal }) => adminApi.agents.list(signal),
  });
  const all = agents.data?.agents ?? [];
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

      <ErrorNotice error={agents.isError ? agents.error : undefined} />
      {agents.isPending && <p role="status">{t('common.loading')}</p>}

      {agents.data &&
        (all.length === 0 ? (
          <div className="grid min-h-40 place-items-center rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            {t('agents.empty')}
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('agents.name')}</TableHead>
                <TableHead>{t('agents.trust_tier')}</TableHead>
                <TableHead>{t('agents.status')}</TableHead>
                <TableHead>{t('agents.credentials')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {all.map((agent) => (
                <TableRow key={agent.id}>
                  <TableCell label={t('agents.name')}>
                    {/* The name is the way in, so the row needs no separate
                        button competing with it for the eye. */}
                    <Button
                      type="button"
                      variant="link"
                      className="h-auto p-0 text-left"
                      onClick={() => setInspecting(agent.id)}
                    >
                      {agent.name}
                    </Button>
                    {agent.client_type && (
                      <>
                        {' '}
                        <code className="text-xs text-muted-foreground">{agent.client_type}</code>
                      </>
                    )}
                  </TableCell>
                  <TableCell label={t('agents.trust_tier')}>
                    {t(`agents.tiers.${agent.trust_tier}`)}
                  </TableCell>
                  <TableCell label={t('agents.status')}>
                    <Badge variant={agent.status === 'active' ? 'default' : 'outline'}>
                      {t(`agents.statuses.${agent.status}`)}
                    </Badge>
                  </TableCell>
                  <TableCell label={t('agents.credentials')}>{agent.active_credentials}</TableCell>
                </TableRow>
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
