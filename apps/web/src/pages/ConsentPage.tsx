import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import type { AuthorizationParams } from '@knoverge/contracts';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { oauthApi } from '../api/oauth.ts';
import { ErrorNotice } from '../components/ErrorNotice.tsx';
import { useQuery } from '@tanstack/react-query';

/** The parameters the authorization endpoint put in the address. */
function paramsOf(search: URLSearchParams): AuthorizationParams | null {
  const required = [
    'client_id',
    'redirect_uri',
    'code_challenge',
    'code_challenge_method',
    'resource',
  ];
  if (required.some((key) => !search.get(key))) return null;
  const state = search.get('state');
  const scope = search.get('scope');
  return {
    client_id: search.get('client_id') as string,
    redirect_uri: search.get('redirect_uri') as string,
    code_challenge: search.get('code_challenge') as string,
    code_challenge_method: 'S256',
    resource: search.get('resource') as string,
    ...(state !== null ? { state } : {}),
    ...(scope !== null ? { scope } : {}),
  };
}

/**
 * Where a person decides whether a connector may act here (ADR 0038).
 *
 * Two things are on the screen and the difference between them matters. The
 * name is the client's own, chosen by whoever registered it, and anybody may
 * register. The host is where the token would actually go, and it is the one
 * part of the request its author cannot misrepresent — so it is shown beside
 * the name rather than hidden behind it.
 *
 * Saying yes creates an agent. That is why this needs the permission that
 * creates agents, and why the workspace is a choice rather than an assumption.
 */
export function ConsentPage() {
  const { t } = useTranslation();
  const [search] = useSearchParams();
  const params = useMemo(() => paramsOf(search), [search]);
  const [chosen, setChosen] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);

  const pending = useQuery({
    queryKey: ['oauth-pending', search.toString()],
    queryFn: ({ signal }) => oauthApi.pending(params as AuthorizationParams, signal),
    enabled: params !== null,
    retry: false,
  });

  if (params === null) {
    return <p role="alert">{t('consent.malformed')}</p>;
  }
  if (pending.isPending) return <p>{t('common.loading')}</p>;
  if (pending.isError) return <ErrorNotice error={pending.error} />;

  // The first workspace until somebody picks another, worked out rather than
  // stored: writing a default into state from an effect is a second render
  // whose only purpose is to say what this line already says.
  const workspaceId = chosen || (pending.data.workspaces[0]?.workspace_id ?? '');

  const answer = async (allow: boolean) => {
    setBusy(true);
    setFailure(null);
    try {
      const result = allow
        ? await oauthApi.consent({ ...params, workspace_id: workspaceId as never })
        : await oauthApi.deny(params);
      // The server decides where this goes, and it only ever names a URI the
      // client registered. The page never builds that address itself.
      window.location.assign(result.redirect_to);
    } catch (error) {
      setFailure(error);
      setBusy(false);
    }
  };

  const nowhere = pending.data.workspaces.length === 0;

  return (
    <div className="mx-auto grid w-full max-w-xl gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('consent.title', { client: pending.data.client_name })}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-5">
          <p className="text-sm text-muted-foreground">{t('consent.explain')}</p>

          <dl className="grid gap-3 text-sm">
            <div className="grid gap-0.5">
              <dt className="text-muted-foreground">{t('consent.name_label')}</dt>
              <dd className="font-medium">{pending.data.client_name}</dd>
            </div>
            <div className="grid gap-0.5">
              <dt className="text-muted-foreground">{t('consent.host_label')}</dt>
              <dd className="font-mono">{pending.data.redirect_host}</dd>
            </div>
          </dl>

          <p className="text-sm text-muted-foreground">{t('consent.name_warning')}</p>

          {nowhere ? (
            <p role="alert" className="text-sm">
              {t('consent.no_workspace')}
            </p>
          ) : (
            <label className="grid gap-1.5 text-sm">
              <span className="text-muted-foreground">{t('consent.workspace_label')}</span>
              <select
                className="h-9 rounded-md border bg-background px-3"
                value={workspaceId}
                onChange={(event) => setChosen(event.target.value)}
              >
                {pending.data.workspaces.map((w) => (
                  <option key={w.workspace_id} value={w.workspace_id}>
                    {w.workspace_name}
                  </option>
                ))}
              </select>
            </label>
          )}

          <p className="text-sm text-muted-foreground">{t('consent.what_it_gets')}</p>

          {failure !== null && <ErrorNotice error={failure} />}

          <div className="flex gap-3">
            <Button onClick={() => void answer(true)} disabled={busy || nowhere}>
              {t('consent.allow')}
            </Button>
            <Button variant="outline" onClick={() => void answer(false)} disabled={busy}>
              {t('consent.deny')}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
