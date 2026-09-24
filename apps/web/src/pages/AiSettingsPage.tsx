import type { AiProviderSummary } from '@knoverge/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Plug, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { AI_SETTINGS_KEY } from '@/lib/query-keys';
import { adminApi } from '../api/admin.ts';
import { relativeTime } from '@/lib/relative-time';
import { ErrorNotice } from '../components/ErrorNotice.tsx';
import { SettingsHeader } from '../components/settings/SettingsHeader.tsx';
import { ProviderWizard, type WizardResult } from '../components/settings/ProviderWizard.tsx';

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
  const [wizard, setWizard] = useState<{ existing?: AiProviderSummary } | null>(null);

  const settings = useQuery({
    queryKey: AI_SETTINGS_KEY,
    queryFn: ({ signal }) => adminApi.ai.settings(signal),
  });

  const refresh = (answer: { ai: unknown }) => {
    client.setQueryData(AI_SETTINGS_KEY, answer);
  };

  const connect = useMutation({
    mutationFn: async (result: WizardResult) => {
      const saved = await adminApi.ai.save({
        ...(result.providerId ? { provider_id: result.providerId as never } : {}),
        kind: result.kind,
        name: result.name,
        base_url: result.baseUrl,
      });
      const provider = saved.ai.providers.find((p) => p.base_url === trimSlashes(result.baseUrl));
      if (!provider) return saved;
      return adminApi.ai.assign({
        purpose: 'embedding',
        provider_id: provider.id,
        model: result.model,
      });
    },
    onSuccess: (answer) => {
      refresh(answer);
      setWizard(null);
    },
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
  const providers = ai?.providers ?? [];

  return (
    <div className="grid gap-8">
      <SettingsHeader title={t('settings.sections.ai.title')} intro={t('ai.intro')} />

      <ErrorNotice error={settings.error ?? connect.error ?? remove.error} />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('ai.embedding.title')}</CardTitle>
          <CardDescription>{t('ai.embedding.description')}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {settings.isPending ? (
            <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
          ) : providers.length === 0 ? (
            <div className="grid gap-3">
              {/* What still works, named, rather than an empty state that
                  reads as something being broken. */}
              <p className="text-sm text-muted-foreground">{t('ai.empty')}</p>
              <Button className="w-fit" onClick={() => setWizard({})}>
                <Plug aria-hidden="true" className="size-4" />
                {t('ai.connect')}
              </Button>
            </div>
          ) : (
            <ul className="grid gap-3">
              {providers.map((provider) => (
                <li key={provider.id}>
                  <ProviderRow
                    provider={provider}
                    model={embedding?.provider_id === provider.id ? embedding.model : null}
                    onChange={() => setWizard({ existing: provider })}
                    onRemove={() => remove.mutate(provider.id)}
                    onRecheck={() => recheck.mutate(provider)}
                    busy={remove.isPending || recheck.isPending}
                  />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* In the plan, not in the product. Shown so that somebody looking for
          where summaries are configured learns the answer is "not yet". */}
      <Card className="opacity-60">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            {t('ai.generation.title')}
            <Badge variant="outline" className="font-normal text-muted-foreground">
              {t('settings.not_yet')}
            </Badge>
          </CardTitle>
          <CardDescription>{t('ai.generation.description')}</CardDescription>
        </CardHeader>
      </Card>

      {wizard && (
        <ProviderWizard
          open
          onOpenChange={(next) => !next && setWizard(null)}
          existing={wizard.existing}
          currentModel={
            wizard.existing && embedding?.provider_id === wizard.existing.id
              ? embedding.model
              : undefined
          }
          onFinish={(result) => connect.mutate(result)}
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

function trimSlashes(url: string): string {
  return url.replace(/\/+$/u, '');
}
