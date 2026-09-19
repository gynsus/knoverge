import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { fetchReadiness } from '../api/health.ts';

export function StatusPage() {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: ['health', 'ready'],
    queryFn: ({ signal }) => fetchReadiness(signal),
    refetchInterval: 30_000,
  });

  return (
    <section className="card" aria-labelledby="status-title">
      <h2 id="status-title">{t('status.title')}</h2>
      {query.isPending && <p role="status">{t('status.loading')}</p>}
      {query.isError && <p role="alert">{t('status.error')}</p>}
      {query.data && (
        <>
          <p data-testid="overall">
            <strong>{query.data.status === 'ok' ? t('status.ok') : t('status.degraded')}</strong>{' '}
            <small>{t('status.version', { version: query.data.version })}</small>
          </p>
          <ul>
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
                    <>
                      <br />
                      <small>{check.error}</small>
                    </>
                  )}
                </li>
              ),
            )}
          </ul>
        </>
      )}
      <button type="button" onClick={() => void query.refetch()} disabled={query.isFetching}>
        {t('status.refresh')}
      </button>
    </section>
  );
}
