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
  const calls: { url: string; method: string; body?: unknown; workspace?: string }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET';
      const workspace = new Headers(init?.headers).get('x-knoverge-workspace');
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
const MEMBERSHIPS = [
  {
    workspace_id: FIRST,
    workspace_slug: 'personal',
    workspace_name: 'Personal',
    workspace_archived_at: null,
    role: 'owner',
  },
  {
    workspace_id: SECOND,
    workspace_slug: 'pixel-brisbane',
    workspace_name: 'Pixel Brisbane',
    workspace_archived_at: null,
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
      archived_at: null,
      role: 'owner',
      item_count: 186,
      agent_count: 2,
      last_activity_at: '2026-09-22T09:00:00.000Z',
      permissions: ['taxonomy.read', 'knowledge.read', 'workspace.admin'],
    },
    {
      id: SECOND,
      slug: 'pixel-brisbane',
      name: 'Pixel Brisbane',
      description: null,
      default_language: 'en',
      created_at: '2026-09-19T00:00:00.000Z',
      archived_at: null,
      role: 'reviewer',
      item_count: 428,
      agent_count: 3,
      last_activity_at: null,
      permissions: ['taxonomy.read', 'knowledge.read'],
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
          archived_at: null,
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

  it('shows what a workspace is before moving into it', async () => {
    const calls = mockApi(signedIn());
    renderApp('/workspaces');
    await screen.findByRole('heading', { name: 'Pixel Brisbane' });
    const user = userEvent.setup();

    // Choosing a card asks about it rather than entering it. Somebody
    // scanning a list is deciding which one they want, and being moved into
    // one because they looked at it is a surprise.
    await user.click(screen.getByRole('button', { name: 'What Pixel Brisbane is' }));
    const panel = await screen.findByRole('dialog');
    expect(within(panel).getByText('428 items')).toBeInTheDocument();
    expect(within(panel).getByText('3 agents')).toBeInTheDocument();
    expect(calls.filter((c) => c.url === '/v1/workspace.get').at(-1)?.workspace).toBe(FIRST);

    await user.click(within(panel).getByRole('button', { name: 'Open' }));
    // Not just navigation: every later request has to name the new workspace,
    // or the page would show one workspace's rows under the other's name.
    await waitFor(() =>
      expect(calls.filter((c) => c.url === '/v1/workspace.get').at(-1)?.workspace).toBe(SECOND),
    );
    expect(await screen.findByText('Your workspaces')).toBeInTheDocument();
  });

  it('creates one in a drawer, from an address the switcher can link to', async () => {
    let memberships = [MEMBERSHIPS[0]!];
    const calls = mockApi({
      ...signedIn(),
      'GET /v1/auth/me': () => json({ user: USER, memberships, session: SESSION }),
      'POST /v1/admin/workspace.create': () => {
        memberships = MEMBERSHIPS;
        return json({ workspace: { ...LISTED.workspaces[1]!, role: 'owner' } });
      },
    });
    renderApp('/workspaces?new');
    const user = userEvent.setup();

    // The form arrives open, because the address said so: a reload does not
    // lose it and the switcher can point straight at it.
    await user.type(await screen.findByLabelText('Name'), 'Pixel Brisbane');
    expect(screen.getByLabelText('Workspace identifier')).toHaveValue('pixel-brisbane');
    await user.click(screen.getByRole('button', { name: 'Create and switch to it' }));

    await waitFor(() =>
      expect(calls.find((c) => c.url === '/v1/admin/workspace.create')).toBeDefined(),
    );
  });

  it('edits the one it was asked about', async () => {
    const calls = mockApi({
      ...signedIn(),
      'POST /v1/admin/workspace.update': () => json({ ok: true }),
    });
    renderApp(`/workspaces?edit=${FIRST}`);
    const user = userEvent.setup();

    const name = await screen.findByLabelText('Name');
    expect(name).toHaveValue('Personal');
    // The identifier is fixed once a workspace exists: the repository is
    // named after it and every path in it would move.
    expect(screen.queryByLabelText('Workspace identifier')).not.toBeInTheDocument();

    await user.clear(name);
    await user.type(name, 'Personal Knowledge');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls.find((c) => c.url === '/v1/admin/workspace.update')?.body).toMatchObject({
        name: 'Personal Knowledge',
      }),
    );
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

  /**
   * An archived workspace is one that is kept and no longer written to.
   *
   * It stays in the list rather than disappearing — somebody who cannot find
   * the one they archived would reasonably conclude it was deleted — but it
   * goes last, it says what it is, and it can be brought back.
   */
  describe('an archived workspace', () => {
    const ARCHIVED = {
      workspaces: [
        { ...LISTED.workspaces[0]!, archived_at: '2026-09-20T00:00:00.000Z' },
        LISTED.workspaces[1]!,
      ],
    };

    it('is marked, sorts last and can be narrowed to', async () => {
      mockApi({ ...signedIn(), 'GET /v1/workspaces.list': () => json(ARCHIVED) });
      renderApp('/workspaces');
      const user = userEvent.setup();

      await screen.findByRole('heading', { name: 'Pixel Brisbane' });
      const personal = cardFor('Personal');
      expect(within(personal).getByText('Archived')).toBeInTheDocument();
      expect(within(cardFor('Pixel Brisbane')).queryByText('Archived')).not.toBeInTheDocument();
      // Last whatever the sort says: it is not what somebody scanning the
      // list is looking for. "Personal" sorts first by activity otherwise.
      expect(
        screen.getAllByRole('button', { name: /^What .+ is$/ }).map((b) => b.textContent),
      ).toEqual(['Pixel Brisbane', 'Personal']);

      await user.selectOptions(screen.getByLabelText('Filter by state'), 'archived');
      expect(await screen.findByText('1 workspace')).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Pixel Brisbane' })).not.toBeInTheDocument();

      await user.selectOptions(screen.getByLabelText('Filter by state'), 'active');
      expect(await screen.findByText('1 workspace')).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Personal' })).not.toBeInTheDocument();
    });

    it('says what archiving does before it happens, and names the workspace it acts on', async () => {
      // An owner of both, so the control is offered for the workspace the
      // interface is not currently in — the case the header has to get right.
      const OWNS_BOTH = {
        workspaces: LISTED.workspaces.map((w) => ({
          ...w,
          permissions: [...w.permissions, 'workspace.admin'],
        })),
      };
      const calls = mockApi({
        ...signedIn(),
        'GET /v1/workspaces.list': () => json(OWNS_BOTH),
        'POST /v1/admin/workspace.archive': () => json({ ok: true }),
      });
      renderApp('/workspaces');
      const user = userEvent.setup();

      await user.click(await screen.findByRole('button', { name: 'What Pixel Brisbane is' }));
      const panel = await screen.findByRole('dialog');
      expect(within(panel).getByText(/stops accepting changes/)).toBeInTheDocument();

      // One click asks, the second one does it.
      await user.click(within(panel).getByRole('button', { name: 'Archive' }));
      expect(calls.some((c) => c.url === '/v1/admin/workspace.archive')).toBe(false);
      await user.click(within(panel).getByRole('button', { name: 'Archive it' }));

      await waitFor(() =>
        expect(calls.find((c) => c.url === '/v1/admin/workspace.archive')).toMatchObject({
          body: { archived: true },
          workspace: SECOND,
        }),
      );
    });

    it('offers the way back', async () => {
      const calls = mockApi({
        ...signedIn(),
        'GET /v1/workspaces.list': () => json(ARCHIVED),
        'POST /v1/admin/workspace.archive': () => json({ ok: true }),
      });
      renderApp('/workspaces');
      const user = userEvent.setup();

      await user.click(await screen.findByRole('button', { name: 'What Personal is' }));
      const panel = await screen.findByRole('dialog');
      expect(within(panel).getByText(/accepts no changes/)).toBeInTheDocument();
      await user.click(within(panel).getByRole('button', { name: 'Bring it back' }));

      await waitFor(() =>
        expect(calls.find((c) => c.url === '/v1/admin/workspace.archive')).toMatchObject({
          body: { archived: false },
          workspace: FIRST,
        }),
      );
    });

    it('is not offered to somebody who does not administer it', async () => {
      mockApi(signedIn());
      renderApp('/workspaces');
      const user = userEvent.setup();

      // A reviewer in Pixel Brisbane: the server's answer for that workspace
      // carries no workspace.admin, so the control is not there to be clicked.
      await user.click(await screen.findByRole('button', { name: 'What Pixel Brisbane is' }));
      const panel = await screen.findByRole('dialog');
      expect(within(panel).queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();
    });
  });
});
