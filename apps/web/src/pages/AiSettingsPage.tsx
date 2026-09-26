import type { AiAssignment, AiProviderSummary } from '@knoverge/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Plug, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { AI_SETTINGS_KEY } from '@/lib/query-keys';
import { adminApi } from '../api/admin.ts';
import { relativeTime } from '@/lib/relative-time';
import { ErrorNotice } from '../components/ErrorNotice.tsx';
import { SettingsHeader } from '../components/settings/SettingsHeader.tsx';
import {
  ProviderWizard,
  type WizardPurpose,
  type WizardResult,
} from '../components/settings/ProviderWizard.tsx';

/**
 * AI and models: what the installation is connected to, and what it uses it for.
 *
 * The page leads with the fact that none of this is required. A self-hosted
 * product whose settings imply an AI provider is mandatory has told its
 * operator something untrue about what they are running (rule 9).
 */
export function AiSettingsPage() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [wizard, setWizard] = useState<{
    existing?: AiProviderSummary;
    purpose: WizardPurpose;
  } | null>(null);

  const settings = useQuery({
    queryKey: AI_SETTINGS_KEY,
    queryFn: ({ signal }) => adminApi.ai.settings(signal),
  });

  const refresh = (answer: { ai: unknown }) => {
    client.setQueryData(AI_SETTINGS_KEY, answer);
  };

  const connect = useMutation({
    mutationFn: async ({ result, purpose }: { result: WizardResult; purpose: WizardPurpose }) => {
      const saved = await adminApi.ai.save({
        ...(result.providerId ? { provider_id: result.providerId as never } : {}),
        kind: result.kind,
        name: result.name,
        base_url: result.baseUrl,
      });
      const provider = saved.ai.providers.find((p) => p.base_url === trimSlashes(result.baseUrl));
      if (!provider) return saved;
      return adminApi.ai.assign({ purpose, provider_id: provider.id, model: result.model });
    },
    onSuccess: (answer) => {
      refresh(answer);
      setWizard(null);
    },
  });

  const stop = useMutation({
    mutationFn: (purpose: WizardPurpose) => adminApi.ai.unassign({ purpose }),
    onSuccess: refresh,
  });

  const remove = useMutation({
    mutationFn: (providerId: string) => adminApi.ai.remove({ provider_id: providerId as never }),
    onSuccess: refresh,
  });

  const recheck = useMutation({
    mutationFn: (provider: AiProviderSummary) =>
      adminApi.ai.check({ kind: provider.kind, base_url: provider.base_url }),
    onSuccess: () => client.invalidateQueries({ queryKey: AI_SETTINGS_KEY }),
  });

  const ai = settings.data?.ai;
  const embedding = ai?.assignments.find((a) => a.purpose === 'embedding');
  const generation = ai?.assignments.find((a) => a.purpose === 'generation');
  const providers = ai?.providers ?? [];
  /** The provider the generation model lives at, when it is still configured. */
  const generatingAt = providers.find((p) => p.id === generation?.provider_id);
  /** Where a purpose row's wizard starts: the only provider, when there is one. */
  const only = providers.length === 1 ? providers[0] : undefined;

  return (
    <div className="grid gap-8">
      <SettingsHeader title={t('settings.sections.ai.title')} intro={t('ai.intro')} />

      <ErrorNotice error={settings.error ?? connect.error ?? remove.error ?? stop.error} />

      {/* No card around these. Each provider is already a framed object, and
          a frame around a list of frames is a line that separates nothing
          (WEB_UI.md rule 2h). */}
      <section aria-labelledby="embedding-title" className="grid gap-4">
        <div className="grid gap-1.5">
          <h3 id="embedding-title" className="text-lg font-semibold">
            {t('ai.embedding.title')}
          </h3>
          <p className="max-w-2xl text-sm text-muted-foreground">{t('ai.embedding.description')}</p>
        </div>

        {settings.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t('common.loading')}
          </p>
        ) : providers.length === 0 ? (
          <EmptyState onConnect={() => setWizard({ purpose: 'embedding' })} />
        ) : (
          <ul className="grid gap-3">
            {providers.map((provider) => (
              <li key={provider.id}>
                <ProviderRow
                  provider={provider}
                  model={embedding?.provider_id === provider.id ? embedding.model : null}
                  onChange={() => setWizard({ existing: provider, purpose: 'embedding' })}
                  onRemove={() => remove.mutate(provider.id)}
                  onRecheck={() => recheck.mutate(provider)}
                  busy={remove.isPending || recheck.isPending}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* A purpose of its own rather than another column on a provider row.
          What writes text and what measures it are different questions, and an
          operator asks them one at a time. */}
      <section aria-labelledby="generation-title" className="grid gap-4">
        <div className="grid gap-1.5">
          <h3 id="generation-title" className="text-lg font-semibold">
            {t('ai.generation.title')}
          </h3>
          <p className="max-w-2xl text-sm text-muted-foreground">
            {t('ai.generation.description')}
          </p>
        </div>

        {settings.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t('common.loading')}
          </p>
        ) : generation ? (
          <div className="grid gap-3 rounded-lg border p-4 sm:grid-cols-[1fr_auto] sm:items-start">
            <div className="grid min-w-0 gap-1">
              <p className="text-sm">{t('ai.generation.in_use', { model: generation.model })}</p>
              <p className="truncate font-mono text-xs text-muted-foreground">
                {generatingAt?.base_url ?? t('ai.generation.provider_gone')}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setWizard({
                    purpose: 'generation',
                    ...(generatingAt ? { existing: generatingAt } : {}),
                  })
                }
              >
                {t('ai.change')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => stop.mutate('generation')}
                disabled={stop.isPending}
              >
                {t('ai.generation.stop')}
              </Button>
            </div>
          </div>
        ) : (
          /* Dashed, like an empty list, and meaning the same thing: there is
             nothing here yet. The difference from before is that there is now
             something to press. */
          <div className="grid gap-3 rounded-lg border border-dashed border-border px-4 py-6">
            <p className="text-sm text-muted-foreground">{t('ai.generation.none')}</p>
            <Button
              className="w-fit"
              disabled={providers.length === 0}
              onClick={() =>
                setWizard({ purpose: 'generation', ...(only ? { existing: only } : {}) })
              }
            >
              <Plug aria-hidden="true" className="size-4" />
              {t('ai.generation.choose')}
            </Button>
            {providers.length === 0 && (
              <p className="text-xs text-muted-foreground">{t('ai.generation.connect_first')}</p>
            )}
          </div>
        )}
      </section>

      {wizard && (
        <ProviderWizard
          open
          onOpenChange={(next) => !next && setWizard(null)}
          existing={wizard.existing}
          purpose={wizard.purpose}
          currentModel={currentModelFor(wizard, embedding, generation)}
          onFinish={(result) => connect.mutate({ result, purpose: wizard.purpose })}
          saving={connect.isPending}
          error={connect.error}
        />
      )}
    </div>
  );
}

/** One configured provider: what it is, when it last answered, what it does. */
function ProviderRow({
  provider,
  model,
  onChange,
  onRemove,
  onRecheck,
  busy,
}: {
  provider: AiProviderSummary;
  model: string | null;
  onChange: () => void;
  onRemove: () => void;
  onRecheck: () => void;
  busy: boolean;
}) {
  const { t, i18n } = useTranslation();
  return (
    <div className="grid gap-3 rounded-lg border p-4 sm:grid-cols-[1fr_auto] sm:items-start">
      <div className="grid min-w-0 gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{provider.name}</span>
          <Badge variant="outline" className="font-normal text-muted-foreground">
            {t(`ai.kinds.${provider.kind}`)}
          </Badge>
          {/* The question an operator asks first when the compose file and
              this page disagree. */}
          <Badge variant="outline" className="font-normal text-muted-foreground">
            {t(`ai.origin.${provider.origin}`)}
          </Badge>
        </div>
        <p className="truncate font-mono text-xs text-muted-foreground">{provider.base_url}</p>
        <p className="text-sm">
          {model ? t('ai.embedding.in_use', { model }) : t('ai.embedding.not_in_use')}
        </p>
        {provider.last_error ? (
          <p className="text-sm break-words text-destructive">{provider.last_error}</p>
        ) : provider.last_checked_at ? (
          <p className="text-xs text-muted-foreground">
            {t('ai.checked', { when: relativeTime(provider.last_checked_at, i18n.language) })}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={onRecheck} disabled={busy}>
          {busy ? (
            <Loader2 aria-hidden="true" className="size-4 animate-spin" />
          ) : (
            <RefreshCw aria-hidden="true" className="size-4" />
          )}
          {t('ai.recheck')}
        </Button>
        <Button variant="outline" size="sm" onClick={onChange}>
          {t('ai.change')}
        </Button>
        <Button variant="ghost" size="sm" onClick={onRemove} disabled={busy}>
          {t('ai.disconnect')}
        </Button>
      </div>
    </div>
  );
}

/**
 * Nothing connected, said as a state rather than as an absence.
 *
 * It names what still works. An empty box here would read as something being
 * broken, and most of the product does not need any of this (rule 9).
 */
function EmptyState({ onConnect }: { onConnect: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="grid min-h-56 place-items-center gap-4 rounded-lg border border-dashed border-border px-6 py-10 text-center">
      <span className="grid size-11 place-items-center rounded-lg bg-muted">
        <Plug className="size-5 text-muted-foreground" aria-hidden="true" />
      </span>
      <p className="mx-auto max-w-md text-sm text-muted-foreground">{t('ai.empty')}</p>
      <Button onClick={onConnect}>
        <Plug aria-hidden="true" className="size-4" />
        {t('ai.connect')}
      </Button>
    </div>
  );
}

function trimSlashes(url: string): string {
  return url.replace(/\/+$/u, '');
}

/**
 * The model the wizard should open on.
 *
 * The one already doing that job at that provider, so reopening starts where
 * things are rather than at an empty select.
 */
function currentModelFor(
  wizard: { existing?: AiProviderSummary; purpose: WizardPurpose },
  embedding: AiAssignment | undefined,
  generation: AiAssignment | undefined,
): string | undefined {
  const assignment = wizard.purpose === 'generation' ? generation : embedding;
  if (!assignment || !wizard.existing) return undefined;
  return assignment.provider_id === wizard.existing.id ? assignment.model : undefined;
}
