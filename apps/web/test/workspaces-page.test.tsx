import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkspacesResponse } from '@knoverge/contracts';

import { resetCsrfToken, setWorkspace } from '../src/api/client.ts';
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
  const calls: { url: string; method: string; workspace?: string }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET';
      const workspace = new Headers(init?.headers).get('x-knoverge-workspace');
      calls.push({ url, method, ...(workspace ? { workspace } : {}) });
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

const FIRST = 'ws_01J8Z3M4Q9V0X7K2B5N6P8R1T3';
const SECOND = 'ws_01J8Z3M4Q9V0X7K2B5N6P8R1T4';

const USER = {
  id: 'usr_01J8Z3M4Q9V0X7K2B5N6P8R1T3',
  email: 'owner@example.com',
  display_name: 'Owner',
  locale: 'en',
  status: 'active',
  created_at: '2026-09-19T00:00:00.000Z',
  last_login_at: null,
};
const SESSION = {
  id: 'sess_01J8Z3M4Q9V0X7K2B5N6P8R1T3',
  expires_at: '2026-10-19T00:00:00.000Z',
};
const MEMBERSHIPS = [
  { workspace_id: FIRST, workspace_slug: 'personal', workspace_name: 'Personal', role: 'owner' },
  {
    workspace_id: SECOND,
    workspace_slug: 'pixel-brisbane',
    workspace_name: 'Pixel Brisbane',
    role: 'reviewer',
  },
];

const LISTED = {
  workspaces: [
    {
      id: FIRST,
      slug: 'personal',
      name: 'Personal',
      description: 'Everything I want my agents to remember.',
      default_language: 'en',
      created_at: '2026-09-19T00:00:00.000Z',
      role: 'owner',
      item_count: 186,
      agent_count: 2,
      last_activity_at: '2026-09-22T09:00:00.000Z',
    },
    {
      id: SECOND,
      slug: 'pixel-brisbane',
      name: 'Pixel Brisbane',
      description: null,
      default_language: 'en',
      created_at: '2026-09-19T00:00:00.000Z',
      role: 'reviewer',
      item_count: 428,
      agent_count: 3,
      last_activity_at: null,
    },
  ],
};

const OWNER_PERMISSIONS = ['taxonomy.read', 'knowledge.read', 'workspace.admin'];

function signedIn(permissions = OWNER_PERMISSIONS): Record<string, Handler> {
  return {
    'GET /v1/auth/status': () => json({ bootstrap_required: false, authenticated: true }),
    'GET /v1/auth/me': () => json({ user: USER, memberships: MEMBERSHIPS, session: SESSION }),
    'GET /v1/auth/csrf': () => json({ token: 'csrf-token' }),
    'GET /v1/workspace.get': () =>
      json({
        workspace: {
          id: FIRST,
          slug: 'personal',
          name: 'Personal',
          description: null,
          default_language: 'en',
          created_at: '2026-09-19T00:00:00.000Z',
          role: 'owner',
        },
        permissions,
      }),
    'GET /v1/workspaces.list': () => json(LISTED),
    'GET /health/ready': () =>
      json({
        status: 'ok',
        version: 'test',
        checks: { database: { status: 'ok' }, data_dir: { status: 'ok' } },
      }),
  };
}

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

/** The card for one workspace, found by the heading that names it. */
function cardFor(name: string): HTMLElement {
  return screen.getByRole('heading', { name }).closest('li') as HTMLElement;
}

beforeEach(() => {
  resetCsrfToken();
  window.localStorage.clear();
  setWorkspace(undefined);
});
afterEach(() => vi.unstubAllGlobals());

describe('fixtures match the contracts', () => {
  it('parses the canned list', () => {
    expect(() => WorkspacesResponse.parse(LISTED)).not.toThrow();
  });
});

describe('the workspaces page', () => {
  it('lists every workspace with what is in it', async () => {
    mockApi(signedIn());
    renderApp('/workspaces');

    // The shell's top bar names the section as well, so this asks for the
    // page's own heading rather than any heading with the word on it.
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Workspaces' }),
    ).toBeInTheDocument();
    expect(await screen.findByText('2 workspaces')).toBeInTheDocument();

    const personal = cardFor('Personal');
    expect(within(personal).getByText('186 items')).toBeInTheDocument();
    expect(within(personal).getByText('2 agents')).toBeInTheDocument();
    expect(within(personal).getByText('Owner')).toBeInTheDocument();
    // The one every other request is currently naming.
    expect(within(personal).getByText('Current')).toBeInTheDocument();

    const pixel = cardFor('Pixel Brisbane');
    expect(within(pixel).getByText('Reviewer')).toBeInTheDocument();
    expect(within(pixel).queryByText('Current')).not.toBeInTheDocument();
    // A workspace with an empty ledger says so rather than showing a date it
    // does not have.
    expect(within(pixel).getByText('Nothing recorded yet')).toBeInTheDocument();
    expect(within(pixel).getByText('No description')).toBeInTheDocument();
  });

  it('searches, filters by role and says how many are left', async () => {
    mockApi(signedIn());
    renderApp('/workspaces');
    await screen.findByRole('heading', { name: 'Personal' });
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Search workspaces'), 'pixel');
    expect(await screen.findByText('1 workspace')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Personal' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear the search' }));
    expect(await screen.findByText('2 workspaces')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Filter by role'), 'owner');
    expect(await screen.findByText('1 workspace')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Personal' })).toBeInTheDocument();
  });

  it('says so instead of showing an empty grid', async () => {
    mockApi(signedIn());
    renderApp('/workspaces');
    await screen.findByRole('heading', { name: 'Personal' });
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Search workspaces'), 'nothing matches this');
    expect(await screen.findByText('No workspaces found')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByRole('heading', { name: 'Personal' })).toBeInTheDocument();
  });

  it('opening one moves into it', async () => {
    const calls = mockApi(signedIn());
    renderApp('/workspaces');
    await screen.findByRole('heading', { name: 'Pixel Brisbane' });
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Pixel Brisbane' }));
    // Not just navigation: every later request has to name the new workspace,
    // or the page would show one workspace's rows under the other's name.
    await waitFor(() =>
      expect(calls.filter((c) => c.url === '/v1/workspace.get').at(-1)?.workspace).toBe(SECOND),
    );
    expect(await screen.findByText('Your workspaces')).toBeInTheDocument();
  });

  it('offers creating one only to somebody who may', async () => {
    mockApi(signedIn());
    const { unmount } = renderApp('/workspaces');
    expect(await screen.findByRole('link', { name: 'Create workspace' })).toBeInTheDocument();
    unmount();

    window.localStorage.clear();
    setWorkspace(undefined);
    mockApi(signedIn(['taxonomy.read', 'knowledge.read']));
    renderApp('/workspaces');
    await screen.findByRole('heading', { name: 'Personal' });
    expect(screen.queryByRole('link', { name: 'Create workspace' })).not.toBeInTheDocument();
  });

  it('keeps the old singular address working', async () => {
    mockApi(signedIn());
    // The section was renamed; an open tab or a bookmark should not become a
    // blank page over it.
    renderApp('/workspace');
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Workspaces' }),
    ).toBeInTheDocument();
  });
});
