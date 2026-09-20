import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { fetchReadiness } from '../api/health.ts';

export function StatusPage() {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: ['health', 'ready'],
    queryFn: ({ signal }) => fetchReadiness(signal),
    refetchInterval: 30_000,
  });

  return (
    <Card aria-labelledby="status-title">
      <CardHeader>
        <CardTitle id="status-title">{t('status.title')}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        {query.isPending && (
          <p role="status" className="text-sm text-muted-foreground">
            {t('status.loading')}
          </p>
        )}
        {query.isError && (
          <p role="alert" className="text-sm text-destructive">
            {t('status.error')}
          </p>
        )}
        {query.data && (
          <>
            <p data-testid="overall" className="flex flex-wrap items-center gap-2">
              <Badge variant={query.data.status === 'ok' ? 'default' : 'destructive'}>
                {query.data.status === 'ok' ? t('status.ok') : t('status.degraded')}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {t('status.version', { version: query.data.version })}
              </span>
            </p>
            <ul className="grid gap-1.5 text-sm">
              {Object.entries(query.data.checks).map(([name, check]) =>
                check === undefined ? null : (
                  <li key={name}>
                    {t(`status.check.${name}`)}: {t(`status.check_status.${check.status}`)}
                    {check.latency_ms !== undefined && (
                      <> ({t('status.latency', { count: check.latency_ms })})</>
                    )}
                    {/* The server sends why a check failed; showing only that it
                        failed sent the operator to curl for the reason. */}
                    {check.error && (
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {check.error}
                      </span>
                    )}
                  </li>
                ),
              )}
            </ul>
          </>
        )}
        <Button
          type="button"
          variant="outline"
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
          className="justify-self-start"
        >
          {t('status.refresh')}
        </Button>
      </CardContent>
    </Card>
  );
}
