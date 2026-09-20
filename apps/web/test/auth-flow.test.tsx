import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MeResponse } from '@knoverge/contracts';

import { resetCsrfToken } from '../src/api/client.ts';
import { App } from '../src/App.tsx';
import { createI18n } from '../src/i18n.ts';

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mockApi(routes: Record<string, Handler>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET';
      calls.push({ url, ...(init ? { init } : {}) });
      const handler = routes[`${method} ${url}`];
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
      workspace_id: 'ws_01J8Z3M4Q9V0X7K2B5N6P8R1T3',
      workspace_slug: 'personal',
      workspace_name: 'Personal',
      role: 'owner',
    },
  ],
  session: { id: 'sess_01J8Z3M4Q9V0X7K2B5N6P8R1T3', expires_at: '2026-10-19T00:00:00.000Z' },
};
const READY = {
  status: 'ok',
  version: 'test',
  checks: { database: { status: 'ok' }, data_dir: { status: 'ok' } },
};

function renderApp(path = '/') {
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

describe('fixtures match the contracts', () => {
  it('parses the canned session response', () => {
    expect(() => MeResponse.parse(ME)).not.toThrow();
  });
});

beforeEach(() => resetCsrfToken());
afterEach(() => vi.unstubAllGlobals());

describe('first run', () => {
  it('redirects to the setup page and creates the administrator', async () => {
    let bootstrapped = false;
    const calls = mockApi({
      'GET /v1/auth/status': () =>
        json({ bootstrap_required: !bootstrapped, authenticated: bootstrapped }),
      'GET /v1/auth/csrf': () => json({ token: 'csrf-1' }),
      'POST /v1/bootstrap': () => {
        bootstrapped = true;
        return json({ user_id: ME.user.id, workspace_id: ME.memberships[0]!.workspace_id });
      },
      'GET /v1/auth/me': () => json(ME),
      'GET /health/ready': () => json(READY),
    });
    renderApp('/');
    expect(await screen.findByRole('heading', { name: 'Set up Knoverge' })).toBeInTheDocument();

    // Both groups read as headings and stand apart from the first field under
    // them. A legend takes no part in the grid gap, so this is not automatic.
    for (const name of ['Administrator', 'First workspace']) {
      const legend = screen.getByText(name, { selector: 'legend' });
      expect(legend.className).toContain('mb-3');
      expect(legend.className).toContain('font-semibold');
    }

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Your name'), 'Owner');
    await user.type(screen.getByLabelText('Email'), 'owner@example.com');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery staple');
    await user.type(screen.getByLabelText('Workspace name'), 'Personal Knowledge');
    expect(screen.getByLabelText('Workspace identifier')).toHaveValue('personal-knowledge');
    await user.click(screen.getByRole('button', { name: 'Create administrator and workspace' }));

    expect(await screen.findByText('Your workspaces')).toBeInTheDocument();
    const post = calls.find((c) => c.url === '/v1/bootstrap');
    expect(post?.init?.headers).toMatchObject({ 'x-csrf-token': 'csrf-1' });
    expect(JSON.parse(post?.init?.body as string)).toMatchObject({
      email: 'owner@example.com',
      display_name: 'Owner',
      locale: 'en',
      workspace: { slug: 'personal-knowledge', name: 'Personal Knowledge' },
    });
  });
});

describe('sign in', () => {
  it('shows the login page for anonymous users and the error for wrong credentials', async () => {
    mockApi({
      'GET /v1/auth/status': () => json({ bootstrap_required: false, authenticated: false }),
      'GET /v1/auth/csrf': () => json({ token: 'csrf-2' }),
      'POST /v1/auth/login': () =>
        json(
          { code: 'UNAUTHENTICATED', message: 'invalid email or password', retryable: false },
          401,
        ),
    });
    renderApp('/');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Email'), 'owner@example.com');
    await user.type(screen.getByLabelText('Password'), 'wrong password!!');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    // One code stands for three different failures (wrong password, expired
    // session, wrong current password), so the text names none of them.
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Please sign in again, or check the details you entered.',
    );
  });

  it('signs in, shows the home page and signs out', async () => {
    let authenticated = false;
    mockApi({
      'GET /v1/auth/status': () => json({ bootstrap_required: false, authenticated }),
      'GET /v1/auth/csrf': () => json({ token: 'csrf-3' }),
      'POST /v1/auth/login': () => {
        authenticated = true;
        return json(ME);
      },
      'POST /v1/auth/logout': () => {
        authenticated = false;
        return json({ ok: true });
      },
      'GET /v1/auth/me': () => json(ME),
      'GET /health/ready': () => json(READY),
    });
    renderApp('/');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Email'), 'owner@example.com');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery staple');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Your workspaces')).toBeInTheDocument();
    expect(screen.getByText(/Personal/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument(),
    );
  });

  it('sends signed-in users away from the setup page', async () => {
    mockApi({
      'GET /v1/auth/status': () => json({ bootstrap_required: false, authenticated: true }),
      'GET /v1/auth/me': () => json(ME),
      'GET /health/ready': () => json(READY),
    });
    renderApp('/setup');
    expect(await screen.findByText('Your workspaces')).toBeInTheDocument();
  });
});
