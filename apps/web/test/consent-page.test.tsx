import { PendingAuthorization } from '@knoverge/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetCsrfToken } from '../src/api/client.ts';
import { App } from '../src/App.tsx';
import { createI18n } from '../src/i18n.ts';

type Handler = (url: string, init?: RequestInit) => Response;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mockApi(routes: Record<string, Handler>) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET';
      calls.push({
        url,
        method,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      // The pending call carries the whole request in its query, so the mock
      // matches on the path and the test asserts the query separately.
      const handler = routes[`${method} ${url.split('?')[0]}`];
      if (!handler)
        return json(
          { code: 'NOT_FOUND', message: `no mock for ${method} ${url}`, retryable: false },
          404,
        );
      return handler(url, init);
    }),
  );
  return calls;
}

const WORKSPACE_ID = 'ws_01J8Z3M4Q9V0X7K2B5N6P8R1T3';

const ME = {
  user: {
    id: 'usr_01J8Z3M4Q9V0X7K2B5N6P8R1T3',
    email: 'owner@example.com',
    display_name: 'Owner',
    locale: 'en',
    status: 'active',
    created_at: '2026-09-19T00:00:00.000Z',
    last_login_at: null,
  },
  memberships: [
    {
      workspace_id: WORKSPACE_ID,
      workspace_slug: 'personal',
      workspace_name: 'Personal',
      workspace_archived_at: null,
      role: 'owner',
    },
  ],
  session: { id: 'sess_01J8Z3M4Q9V0X7K2B5N6P8R1T3', expires_at: '2026-10-19T00:00:00.000Z' },
};

const SIGNED_IN: Record<string, Handler> = {
  'GET /v1/auth/status': () => json({ bootstrap_required: false, authenticated: true }),
  'GET /v1/auth/me': () => json(ME),
  'GET /v1/auth/csrf': () => json({ token: 'csrf-token' }),
};

const PENDING = {
  client_name: 'ChatGPT',
  redirect_host: 'chat.example',
  resource: 'https://knoverge.example/mcp',
  workspaces: [
    { workspace_id: WORKSPACE_ID, workspace_slug: 'personal', workspace_name: 'Personal' },
  ],
  replaces: {},
};

/** The address the authorization endpoint sends the browser to. */
const REQUEST =
  '/oauth/consent?client_id=abc&redirect_uri=https%3A%2F%2Fchat.example%2Fcallback' +
  '&code_challenge=' +
  'c'.repeat(43) +
  '&code_challenge_method=S256&resource=https%3A%2F%2Fknoverge.example%2Fmcp&state=xyz';

function renderApp(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <I18nextProvider i18n={createI18n('en')}>
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

beforeEach(() => {
  resetCsrfToken();
  window.localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe('fixtures match the contract', () => {
  it('parses what the server answers', () => {
    expect(() => PendingAuthorization.parse(PENDING)).not.toThrow();
  });
});

describe('the consent screen', () => {
  it('shows the host the token goes to beside the name the client chose', async () => {
    mockApi({ ...SIGNED_IN, 'GET /v1/admin/oauth.pending': () => json(PENDING) });
    renderApp(REQUEST);

    // The name is whatever whoever registered typed. The host is where the
    // token actually goes, and it is the part that cannot be faked — so a
    // screen that showed only the name would be a phishing page with a button.
    await waitFor(() => expect(screen.getByText('chat.example')).toBeInTheDocument());
    expect(screen.getAllByText(/ChatGPT/).length).toBeGreaterThan(0);
    expect(screen.getByText(/anybody can register one/i)).toBeInTheDocument();
  });

  it('sends the request back with the workspace, and follows where the server says', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    const calls = mockApi({
      ...SIGNED_IN,
      'GET /v1/admin/oauth.pending': () => json(PENDING),
      'POST /v1/admin/oauth.consent': () =>
        json({ redirect_to: 'https://chat.example/callback?code=xyz' }),
    });
    renderApp(REQUEST);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith('https://chat.example/callback?code=xyz'),
    );
    const consent = calls.find((c) => c.url.endsWith('/v1/admin/oauth.consent'));
    expect(consent?.body).toMatchObject({
      client_id: 'abc',
      redirect_uri: 'https://chat.example/callback',
      state: 'xyz',
      workspace_id: WORKSPACE_ID,
    });
  });

  it('says so when there is nowhere the person may connect anything', async () => {
    mockApi({
      ...SIGNED_IN,
      'GET /v1/admin/oauth.pending': () => json({ ...PENDING, workspaces: [] }),
    });
    renderApp(REQUEST);

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled();
  });

  it('names the connection it would replace, before anything is replaced', async () => {
    mockApi({
      ...SIGNED_IN,
      'GET /v1/admin/oauth.pending': () =>
        json({ ...PENDING, replaces: { [WORKSPACE_ID]: 'Claude (Owner)' } }),
    });
    renderApp(REQUEST);

    // A hosted connector registers itself again whenever it is reconnected, so
    // the one being added is usually the one already here. It is replaced
    // either way; saying so first is the difference between reconnecting and
    // finding out afterwards.
    await waitFor(() => expect(screen.getByText(/Claude \(Owner\)/)).toBeInTheDocument());
  });

  it('refuses an address that is missing part of the request', async () => {
    mockApi(SIGNED_IN);
    renderApp('/oauth/consent?client_id=abc');
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('alert').textContent).toMatch(/incomplete/i);
  });
});
