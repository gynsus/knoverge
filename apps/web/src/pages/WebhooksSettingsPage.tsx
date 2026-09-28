import type { WebhookSummary } from '@knoverge/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Webhook } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';

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
import { WEBHOOKS_KEY } from '@/lib/query-keys';
import { relativeTime } from '@/lib/relative-time';
import { adminApi } from '../api/admin.ts';
import { useWorkspaceContext } from '../auth/use-workspace.ts';
import { ErrorNotice } from '../components/ErrorNotice.tsx';
import { SettingsHeader } from '../components/settings/SettingsHeader.tsx';
import { standingOf, type Standing } from '../components/webhooks/delivery.ts';
import { WebhookForm } from '../components/webhooks/WebhookForm.tsx';
import { WebhookSecret } from '../components/webhooks/WebhookSecret.tsx';

/**
 * Where this workspace pushes word that something happened.
 *
 * The door through which this product calls a machine the operator named, and
 * until now the only way to open it was a `curl` from inside the container. Rule
 * 12 makes the asking the whole feature, and "the operator will write a request
 * by hand" is not an honest way to ask.
 *
 * What leaves is an event and never the knowledge (ADR 0029), which the page
 * says at the top rather than in the documentation: somebody deciding whether to
 * point this at a third party is deciding exactly that question.
 */
export function WebhooksSettingsPage() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const workspaces = useWorkspaceContext();
  const [params, setParams] = useSearchParams();
  const [secret, setSecret] = useState<string | null>(null);
  const [removing, setRemoving] = useState<WebhookSummary | null>(null);

  const webhooks = useQuery({
    queryKey: WEBHOOKS_KEY,
    queryFn: ({ signal }) => adminApi.webhooks.list(signal),
  });

  const remove = useMutation({
    mutationFn: (webhook: WebhookSummary) => adminApi.webhooks.remove({ webhook_id: webhook.id }),
    onSuccess: async () => {
      setRemoving(null);
      await client.invalidateQueries({ queryKey: WEBHOOKS_KEY });
    },
  });

  const all = webhooks.data?.webhooks ?? [];
  // The installation's answer, not the caller's: without a key there is nowhere
  // safe to keep a signing secret, so nobody can create one here.
  const canKeepSecrets = webhooks.data?.secret_storage_configured ?? true;
  const mayAdminister = workspaces.can('workspace.admin');

  // In the address, so a half-filled form survives a reload and a colleague can
  // be sent the endpoint somebody is asking about (WEB_UI.md rule 2).
  const editingId = params.get('webhook');
  const creating = params.has('new');
  const editing = editingId ? (all.find((w) => w.id === editingId) ?? null) : null;
  const formOpen = creating || editing !== null;
  const closeForm = () => {
    const next = new URLSearchParams(params);
    next.delete('new');
    next.delete('webhook');
    setParams(next, { replace: true });
  };
  const openForm = (webhook: WebhookSummary | null) => {
    const next = new URLSearchParams(params);
    next.delete('new');
    next.delete('webhook');
    if (webhook) next.set('webhook', webhook.id);
    else next.set('new', '');
    setParams(next, { replace: true });
  };

  return (
    <div className="grid gap-8">
      <SettingsHeader title={t('settings.sections.webhooks.title')} intro={t('webhooks.intro')} />

      <ErrorNotice error={webhooks.error ?? remove.error} />

      {/* Before the form rather than after the save: a page that offers a button
          and then refuses what it produced has wasted somebody's time and taught
          them nothing about their installation (WEB_UI.md rule 2m). */}
      {!canKeepSecrets && (
        <div className="grid gap-1 rounded-lg border border-dashed border-border p-4">
          <p className="text-sm font-medium">{t('webhooks.no_key_title')}</p>
          <p className="text-sm text-muted-foreground">{t('webhooks.no_key')}</p>
          <code className="mt-1 w-fit rounded bg-muted px-2 py-1 text-xs">
            KNOVERGE_ENCRYPTION_KEY
          </code>
        </div>
      )}

      <section aria-labelledby="endpoints-title" className="grid gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="grid gap-1.5">
            <h3 id="endpoints-title" className="text-lg font-semibold">
              {t('webhooks.endpoints')}
            </h3>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {t('webhooks.endpoints_hint')}
            </p>
          </div>
          {mayAdminister && (
            <Button className="w-fit" disabled={!canKeepSecrets} onClick={() => openForm(null)}>
              <Plus aria-hidden="true" className="size-4" />
              {t('webhooks.add')}
            </Button>
          )}
        </div>

        {webhooks.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t('common.loading')}
          </p>
        ) : all.length === 0 ? (
          <div className="grid justify-items-start gap-2 rounded-lg border border-dashed border-border px-4 py-6">
            <Webhook aria-hidden="true" className="size-5 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{t('webhooks.empty')}</p>
          </div>
        ) : (
          <ul className="grid gap-3">
            {all.map((webhook) => (
              <li key={webhook.id}>
                <Endpoint
                  webhook={webhook}
                  mayAdminister={mayAdminister}
                  onEdit={() => openForm(webhook)}
                  onRemove={() => setRemoving(webhook)}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      {formOpen && (
        <WebhookForm
          // Keyed on what is being edited, so the drawer starts from that
          // endpoint rather than from whatever the last one left behind.
          key={editing?.id ?? 'new'}
          webhook={editing}
          open
          onOpenChange={(next) => {
            if (!next) closeForm();
          }}
          onSaved={async (issued) => {
            await client.invalidateQueries({ queryKey: WEBHOOKS_KEY });
            closeForm();
            // Only when this save created it. A change keeps the secret it had,
            // which is why the form can offer changing a URL without it.
            if (issued) setSecret(issued);
          }}
        />
      )}

      {secret !== null && <WebhookSecret secret={secret} onClose={() => setSecret(null)} />}

      <Dialog open={removing !== null} onOpenChange={(next) => !next && setRemoving(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('webhooks.remove_title')}</DialogTitle>
            {/* Named, and the consequence stated before the click: the position
                in the ledger goes with it, so the same URL added again starts
                from now and never hears what it missed (WEB_UI.md rule 4). */}
            <DialogDescription>{t('webhooks.remove_effect')}</DialogDescription>
          </DialogHeader>
          <code className="rounded-md border border-border bg-muted/40 p-3 text-xs break-all">
            {removing?.url}
          </code>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setRemoving(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => removing && remove.mutate(removing)}
            >
              {remove.isPending ? t('common.working') : t('webhooks.remove')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * The tone a standing is shown in, and nothing else.
 *
 * Only failing is loud. An endpoint that is off is off because somebody turned
 * it off, and one that has had nothing to say yet is not a problem either —
 * colouring those would spend the reader's alarm on states nobody has to act on.
 */
const TONE: Record<Standing, 'default' | 'destructive' | 'outline'> = {
  delivering: 'default',
  waiting: 'outline',
  failing: 'destructive',
  disabled: 'outline',
};

/**
 * One endpoint: where it points, what it is told, and how it is going.
 *
 * The health is the reason this screen exists at all — `webhooks.list` carried
 * the failure count and the last error from the first day, and nothing showed
 * them, so an endpoint that stopped working stopped working silently.
 */
function Endpoint({
  webhook,
  mayAdminister,
  onEdit,
  onRemove,
}: {
  webhook: WebhookSummary;
  mayAdminister: boolean;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const { t, i18n } = useTranslation();
  const standing = standingOf(webhook);
  const types = webhook.event_types;

  return (
    <div className="grid gap-3 rounded-lg border border-border p-4 sm:grid-cols-[1fr_auto] sm:items-start">
      <div className="grid min-w-0 gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          {/* Text rather than a link, deliberately. Rule 2k makes an address a
              link where a browser can fetch what is there; this one answers a
              POST from this server and would answer a reader's click with a
              refusal, which is not what a link promises. */}
          <code className="min-w-0 text-sm break-all">{webhook.url}</code>
          <Badge variant={TONE[standing]}>{t(`webhooks.standings.${standing}`)}</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          {types.length === 0
            ? t('webhooks.tells_everything')
            : t('webhooks.tells_types', {
                count: types.length,
                names: types
                  .slice(0, 3)
                  .map((type) => t(`events.types.${type}`))
                  .join(', '),
              })}
        </p>
        <p className="text-sm text-muted-foreground">
          {webhook.last_delivery_at
            ? t('webhooks.last_delivery', {
                when: relativeTime(webhook.last_delivery_at, i18n.language),
              })
            : t('webhooks.never_delivered')}
        </p>
        {webhook.failures > 0 && (
          <p className="text-sm text-destructive">
            {t('webhooks.failing', { count: webhook.failures })}
            {webhook.next_attempt_at &&
              ` ${t('webhooks.next_attempt', {
                when: relativeTime(webhook.next_attempt_at, i18n.language),
              })}`}
          </p>
        )}
        {webhook.last_error && (
          // Verbatim, and it is never a secret and never a response body: the
          // server keeps it that way, and an error nobody can read is a support
          // ticket rather than an answer.
          <p className="text-sm break-words text-muted-foreground">
            {t('webhooks.last_error', { error: webhook.last_error })}
          </p>
        )}
      </div>
      {mayAdminister && (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={onEdit}>
            {t('webhooks.edit')}
          </Button>
          <Button variant="ghost" size="sm" onClick={onRemove}>
            {t('webhooks.remove')}
          </Button>
        </div>
      )}
    </div>
  );
}
