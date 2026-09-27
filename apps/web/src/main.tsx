import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { setNonce } from 'get-nonce';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import { BrowserRouter } from 'react-router';

import { ApiRequestError } from './api/client.ts';
import { App } from './App.tsx';
import { createI18n } from './i18n.ts';
import './index.css';

/**
 * The nonce this page was served with, handed to the one library that needs it.
 *
 * Radix locks the page scroll through `react-remove-scroll`, which injects a
 * `<style>` element to compensate for the scrollbar width. The policy allows
 * inline styles only by nonce (`style-src 'self' 'nonce-…'`), so without this
 * every dialog and popover was blocked and the page jumped by a scrollbar.
 *
 * Read from a `<meta>` rather than a global set by an inline script: a script
 * would itself have needed a nonce in `script-src`, widening the policy to
 * solve a problem in the other one.
 */
const nonce = document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content;
if (nonce) setNonce(nonce);

const i18n = createI18n();
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A refusal or a missing page will not become an answer by asking again,
      // and the default of three retries with backoff makes the reader wait
      // about seven seconds on "Loading..." before being told.
      retry: (failures, error) =>
        !(error instanceof ApiRequestError && error.status < 500) && failures < 3,
    },
  },
});

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element #root not found');
}

createRoot(container).render(
  <StrictMode>
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </I18nextProvider>
  </StrictMode>,
);
