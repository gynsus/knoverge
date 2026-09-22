import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CreateWorkspaceResponse, MeResponse } from '@knoverge/contracts';

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
  const calls: { url: string; method: string; body: unknown; workspace?: string }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET';
      const headers = new Headers(init?.headers);
      const workspace = headers.get('x-knoverge-workspace');
      calls.push({
        url,
        method,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        ...(workspace ? { workspace } : {}),
      });
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

const MEMBERSHIP = {
  first: {
    workspace_id: FIRST,
    workspace_slug: 'personal',
    workspace_name: 'Personal',
    role: 'owner',
  },
  second: {
    workspace_id: SECOND,
    workspace_slug: 'pixel-brisbane',
    workspace_name: 'Pixel Brisbane',
    role: 'reviewer',
  },
};

const OWNER_PERMISSIONS = ['taxonomy.read', 'knowledge.read', 'workspace.admin'];
const REVIEWER_PERMISSIONS = ['taxonomy.read', 'knowledge.read'];

function workspaceOf(id: string) {
  return id === SECOND
    ? {
        id: SECOND,
        slug: 'pixel-brisbane',
        name: 'Pixel Brisbane',
        description: null,
        default_language: 'en',
        created_at: '2026-09-19T00:00:00.000Z',
        role: 'reviewer',
      }
    : {
        id: FIRST,
        slug: 'personal',
        name: 'Personal',
        description: null,
        default_language: 'en',
        created_at: '2026-09-19T00:00:00.000Z',
        role: 'owner',
      };
}

/** `memberships` decides what the switcher has to offer. */
function signedIn(memberships: unknown[]): Record<string, Handler> {
  return {
    'GET /v1/auth/status': () => json({ bootstrap_required: false, authenticated: true }),
    'GET /v1/auth/me': () => json({ user: USER, memberships, session: SESSION }),
    'GET /v1/auth/csrf': () => json({ token: 'csrf-token' }),
    'GET /v1/workspace.get': (_url, init) => {
      const id = new Headers(init?.headers).get('x-knoverge-workspace') ?? FIRST;
      return json({
        workspace: workspaceOf(id),
        permissions: id === SECOND ? REVIEWER_PERMISSIONS : OWNER_PERMISSIONS,
      });
    },
    'GET /health/ready': () =>
      json({
        status: 'ok',
        version: 'test',
        checks: { database: { status: 'ok' }, data_dir: { status: 'ok' } },
      }),
  };
}

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

beforeEach(() => {
  resetCsrfToken();
  // The choice is remembered per browser, and a remembered one from the test
  // before would decide which workspace this one starts in.
  window.localStorage.clear();
  setWorkspace(undefined);
});
afterEach(() => vi.unstubAllGlobals());

describe('fixtures match the contracts', () => {
  it('parses the canned session', () => {
    expect(() =>
      MeResponse.parse({
        user: USER,
        memberships: [MEMBERSHIP.first, MEMBERSHIP.second],
        session: SESSION,
      }),
    ).not.toThrow();
  });
});

describe('the workspace switcher', () => {
  it('names the workspace even when there is only one', async () => {
    mockApi(signedIn([MEMBERSHIP.first]));
    renderApp('/');

    // Not hidden away until a second workspace exists: it answers "where am
    // I", and it is where the second one is made.
    const trigger = await screen.findByRole('button', { name: /Current workspace: Personal/ });
    expect(within(trigger).getByText('Personal')).toBeInTheDocument();
    expect(within(trigger).getByText('Owner')).toBeInTheDocument();
  });

  it('lists the workspaces, marks the current one and switches', async () => {
    const calls = mockApi(signedIn([MEMBERSHIP.first, MEMBERSHIP.second]));
    renderApp('/');
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: /Current workspace: Personal/ }));
    const items = await screen.findAllByRole('menuitemradio');
    expect(items.map((i) => i.textContent)).toEqual([
      'Personalpersonal',
      'Pixel Brisbanepixel-brisbane',
    ]);
    // Which one is in force is announced, not only drawn.
    expect(items[0]).toBeChecked();
    expect(items[1]).not.toBeChecked();

    await user.click(items[1]!);
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /Current workspace: Pixel Brisbane/ }),
      ).toBeVisible(),
    );
    // Everything asked for from here on is asked of the new workspace.
    expect(calls.filter((c) => c.url === '/v1/workspace.get').at(-1)?.workspace).toBe(SECOND);
  });

  it('offers creating one to somebody who may, and not to somebody who may not', async () => {
    mockApi(signedIn([MEMBERSHIP.first]));
    const { unmount } = renderApp('/');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Current workspace: Personal/ }));
    expect(screen.getByRole('menuitem', { name: 'Create workspace' })).toBeInTheDocument();
    unmount();

    // The same person in a workspace where they are a reviewer: the server
    // would refuse, so the interface does not offer it.
    window.localStorage.clear();
    setWorkspace(undefined);
    mockApi(signedIn([MEMBERSHIP.second]));
    renderApp('/');
    await user.click(await screen.findByRole('button', { name: /Current workspace: Pixel/ }));
    expect(screen.queryByRole('menuitem', { name: 'Create workspace' })).not.toBeInTheDocument();
  });

  it('creates a workspace and moves into it', async () => {
    let memberships = [MEMBERSHIP.first];
    const calls = mockApi({
      ...signedIn([MEMBERSHIP.first]),
      'GET /v1/auth/me': () => json({ user: USER, memberships, session: SESSION }),
      'POST /v1/admin/workspace.create': () => {
        memberships = [MEMBERSHIP.first, MEMBERSHIP.second];
        return json({ workspace: workspaceOf(SECOND) });
      },
    });
    renderApp('/workspace/new');
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText('Name'), 'Pixel Brisbane');
    // The identifier follows the name until somebody edits it.
    expect(screen.getByLabelText('Workspace identifier')).toHaveValue('pixel-brisbane');
    await user.click(screen.getByRole('button', { name: 'Create and switch to it' }));

    const post = calls.find((c) => c.url === '/v1/admin/workspace.create');
    expect(post?.body).toMatchObject({ slug: 'pixel-brisbane', name: 'Pixel Brisbane' });
    expect(() => CreateWorkspaceResponse.parse({ workspace: workspaceOf(SECOND) })).not.toThrow();

    // Creating one puts you in it: staying behind leaves somebody hunting for
    // the switcher to finish what they asked for.
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /Current workspace: Pixel Brisbane/ }),
      ).toBeVisible(),
    );
  });
});
