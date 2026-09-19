import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createI18n } from '../src/i18n.ts';
import { StatusPage } from '../src/pages/StatusPage.tsx';

function renderPage(locale: 'en' | 'ru' = 'en') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <I18nextProvider i18n={createI18n(locale)}>
      <QueryClientProvider client={client}>
        <StatusPage />
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

function mockFetch(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('StatusPage', () => {
  it('shows a healthy server', async () => {
    mockFetch(200, {
      status: 'ok',
      version: '0.0.0',
      checks: { database: { status: 'ok', latency_ms: 2 }, data_dir: { status: 'ok' } },
    });
    renderPage();
    expect(await screen.findByText('All checks passed')).toBeInTheDocument();
    expect(screen.getByText(/Database: OK/)).toBeInTheDocument();
  });

  it('shows a degraded server from a 503 body, in Russian', async () => {
    mockFetch(503, {
      status: 'degraded',
      version: '0.0.0',
      checks: {
        database: { status: 'failed', error: 'refused' },
        data_dir: { status: 'ok' },
      },
    });
    renderPage('ru');
    expect(await screen.findByText('Часть проверок не пройдена')).toBeInTheDocument();
    expect(screen.getByText(/База данных: Ошибка/)).toBeInTheDocument();
  });

  it('shows an error when the server is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network down');
      }),
    );
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('The server could not be reached.');
  });
});
