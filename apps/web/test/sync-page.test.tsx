import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncRunsResponse } from '@knoverge/contracts';

import { resetCsrfToken, setWorkspace } from '../src/api/client.ts';
import { App } from '../src/App.tsx';
import { createI18n } from '../src/i18n.ts';

type Handler = () => Response;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mockApi(routes: Record<string, Handler>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const handler = routes[`${init?.method ?? 'GET'} ${url}`];
      return handler
        ? handler()
        : json({ code: 'NOT_FOUND', message: `no mock for ${url}`, retryable: false }, 404);
    }),
  );
}

const WORKSPACE = 'ws_01J8Z3M4Q9V0X7K2B5N6P8R1T3';
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
      workspace_id: WORKSPACE,
      workspace_slug: 'personal',
      workspace_name: 'Personal',
      role: 'owner',
    },
  ],
  session: { id: 'sess_01J8Z3M4Q9V0X7K2B5N6P8R1T3', expires_at: '2026-10-19T00:00:00.000Z' },
};

const RUNS = {
  runs: [
    {
      sync_session_id: 'sync_01J8Z3M4Q9V0X7K2B5N6P8R1T3',
      agent_id: 'ag_01J8Z3M4Q9V0X7K2B5N6P8R1T3',
      agent_name: 'Claude Code',
      source_system: 'claude-code',
      source_namespace: 'project-x',
      state: 'completed',
      counts: {
        exact_known: 932,
        likely_match: 104,
        new_candidate: 92,
        conflict: 13,
        agent_copy_stale: 0,
        server_copy_stale: 81,
        ambiguous: 62,
        ignored: 0,
      },
      candidate_count: 1284,
      pending_count: 0,
      proposal_count: 92,
      created_at: '2026-09-22T09:00:00.000Z',
      completed_at: '2026-09-22T09:40:00.000Z',
    },
  ],
};

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

const SIGNED_IN: Record<string, Handler> = {
  'GET /v1/auth/status': () => json({ bootstrap_required: false, authenticated: true }),
  'GET /v1/auth/me': () => json(ME),
  'GET /v1/auth/csrf': () => json({ token: 'csrf-token' }),
  'GET /v1/workspace.get': () =>
    json({
      workspace: {
        id: WORKSPACE,
        slug: 'personal',
        name: 'Personal',
        description: null,
        default_language: 'en',
        created_at: '2026-09-19T00:00:00.000Z',
        role: 'owner',
      },
      permissions: ['knowledge.read', 'proposal.read_all', 'knowledge.approve'],
    }),
};

beforeEach(() => {
  resetCsrfToken();
  window.localStorage.clear();
  setWorkspace(undefined);
});
afterEach(() => vi.unstubAllGlobals());

describe('fixtures match the contracts', () => {
  it('parses the canned runs', () => {
    expect(() => SyncRunsResponse.parse(RUNS)).not.toThrow();
  });
});

describe('the reconciliation page', () => {
  it('leads with how much an agent offered that the workspace already had', async () => {
    mockApi({ ...SIGNED_IN, 'GET /v1/admin/sync.list': () => json(RUNS) });
    renderApp('/sync');

    // The one number the product is judged on. An agent offering twelve
    // hundred candidates and finding nine hundred already recorded is this
    // working; the same agent proposing nine hundred is it having failed.
    expect(await screen.findByText('932 of 1284 already recorded here')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Claude Code' })).toBeInTheDocument();
  });

  it('opens the run in a drawer, with the classifications and a way to the inbox', async () => {
    mockApi({
      ...SIGNED_IN,
      'GET /v1/admin/sync.list': () => json(RUNS),
      'POST /v1/proposal_list': () => json({ proposals: [{ id: 'prop_1' }, { id: 'prop_2' }] }),
    });
    renderApp('/sync');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'What Claude Code found' }));

    const panel = await screen.findByRole('dialog');
    expect(within(panel).getByText('1284 candidates offered')).toBeInTheDocument();
    expect(within(panel).getByText('Already recorded')).toBeInTheDocument();
    // A classification nothing fell into is not a row: a column of zeroes is
    // noise between the numbers that matter.
    expect(within(panel).queryByText('The workspace is ahead')).not.toBeInTheDocument();

    // Straight to the proposals this run produced, filtered to the run.
    const review = await within(panel).findByRole('link', { name: 'Review them' });
    expect(review).toHaveAttribute(
      'href',
      '/review?sync_session_id=sync_01J8Z3M4Q9V0X7K2B5N6P8R1T3',
    );
  });

  it('says so when nothing has reconciled yet', async () => {
    mockApi({ ...SIGNED_IN, 'GET /v1/admin/sync.list': () => json({ runs: [] }) });
    renderApp('/sync');
    expect(await screen.findByText('No reconciliation yet')).toBeInTheDocument();
  });
});

describe('the link from a run to its proposals', () => {
  it('asks the server for that run, not for everything pending', async () => {
    const asked: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        asked.push(url);
        const routes: Record<string, Handler> = {
          ...SIGNED_IN,
          'GET /v1/admin/sync.list': () => json(RUNS),
          [`GET /v1/proposal.list?status=pending&sync_session_id=${RUNS.runs[0]!.sync_session_id}`]:
            () => json({ proposals: [] }),
        };
        const handler = routes[`${init?.method ?? 'GET'} ${url}`];
        return handler
          ? handler()
          : json({ code: 'NOT_FOUND', message: url, retryable: false }, 404);
      }),
    );

    // A link that carries a filter the page ignores is a link that lies, so
    // the address is what the request is built from.
    renderApp(`/review?sync_session_id=${RUNS.runs[0]!.sync_session_id}`);
    await screen.findByText('From one reconciliation run');
    expect(
      asked.some((url) => url.includes(`sync_session_id=${RUNS.runs[0]!.sync_session_id}`)),
    ).toBe(true);
  });
});
