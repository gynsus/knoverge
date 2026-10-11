import { GardeningRunsResponse, GardeningSettingsResponse } from '@knoverge/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
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

function signedIn(permissions: string[] = ['workspace.admin', 'knowledge.read']) {
  return {
    'GET /v1/auth/status': () => json({ bootstrap_required: false, authenticated: true }),
    'GET /v1/auth/me': () => json(ME),
    'GET /v1/auth/csrf': () => json({ token: 'csrf-token' }),
    'GET /v1/workspace.get': () =>
      json({
        workspace: {
          id: WORKSPACE_ID,
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
    'GET /v1/actors.list': () => json({ actors: [] }),
  } satisfies Record<string, Handler>;
}

/** A workspace nobody has configured: the defaults, and gardening off. */
const OFF = {
  enabled: false,
  interval_hours: 24,
  max_findings_per_run: 50,
  max_findings_per_rule: 20,
  last_run_at: null,
  rules: ['duplicate_content_hash' as const],
};

const RUN = {
  id: 'grun_01J8Z3M4Q9V0X7K2B5N6P8R1T3',
  trigger: 'scheduled' as const,
  started_at: '2026-10-10T08:00:00.000Z',
  finished_at: '2026-10-10T08:00:04.000Z',
  findings_filed: 2,
  reached_cap: false,
  error: null,
  rules: [
    {
      rule: 'duplicate_content_hash' as const,
      examined: 412,
      found: 2,
      filed: 2,
      limited: null,
    },
  ],
};

function renderApp(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <I18nextProvider i18n={createI18n('en')}>
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>
    </I18nextProvider>,
  );
  return client;
}

/** Every query answered: what a person may do arrives in its own request. */
async function settled(client: QueryClient): Promise<void> {
  await waitFor(() => expect(client.isFetching()).toBe(0));
}

describe('fixtures match the contract', () => {
  it('parses what the server answers', () => {
    expect(() => GardeningSettingsResponse.parse({ settings: OFF })).not.toThrow();
    expect(() => GardeningRunsResponse.parse({ runs: [RUN] })).not.toThrow();
  });
});

beforeEach(() => {
  resetCsrfToken();
  window.localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe('a workspace nobody has configured', () => {
  it('says gardening is off and names the rule that would run', async () => {
    mockApi({
      ...signedIn(),
      'GET /v1/admin/gardening.settings': () => json({ settings: OFF }),
      'GET /v1/admin/gardening.runs': () => json({ runs: [] }),
    });
    renderApp('/gardening');

    expect(
      await screen.findByRole('checkbox', { name: /garden this workspace/i }),
    ).not.toBeChecked();
    // Named rather than counted: a rule that found nothing has to be
    // distinguishable from one that does not exist.
    expect(screen.getByText(/the same thing twice/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing has run yet/i)).toBeInTheDocument();
  });

  it('says what the run will do before the button is pressed', async () => {
    mockApi({
      ...signedIn(),
      'GET /v1/admin/gardening.settings': () => json({ settings: OFF }),
      'GET /v1/admin/gardening.runs': () => json({ runs: [] }),
    });
    renderApp('/gardening');

    // The consequence, before the click: this one makes work for a person
    // (WEB_UI.md rule 4).
    expect(
      await screen.findByText(/files what it finds into the review queue/i),
    ).toBeInTheDocument();
  });
});

describe('the schedule and the caps', () => {
  it('are sent in one call, because that is how the server takes them', async () => {
    const calls = mockApi({
      ...signedIn(),
      'GET /v1/admin/gardening.settings': () => json({ settings: OFF }),
      'GET /v1/admin/gardening.runs': () => json({ runs: [] }),
      'POST /v1/admin/gardening.save': () =>
        json({ settings: { ...OFF, enabled: true, max_findings_per_run: 10 } }),
    });
    renderApp('/gardening');

    await userEvent.click(await screen.findByRole('checkbox', { name: /garden this workspace/i }));
    const perRun = screen.getByLabelText(/findings per run/i);
    await userEvent.clear(perRun);
    await userEvent.type(perRun, '10');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(screen.getByText(/saved\./i)).toBeInTheDocument());
    const save = calls.find((call) => call.url.endsWith('gardening.save'));
    // One call with the whole setting: a form the same shape as the call, so
    // the screen promises no granularity the server does not have (rule 2m).
    expect(save?.body).toEqual({
      enabled: true,
      interval_hours: 24,
      max_findings_per_run: 10,
      max_findings_per_rule: 20,
    });
  });
});

describe('a run that has happened', () => {
  it('says what the rule read, found and filed', async () => {
    mockApi({
      ...signedIn(),
      'GET /v1/admin/gardening.settings': () => json({ settings: { ...OFF, enabled: true } }),
      'GET /v1/admin/gardening.runs': () => json({ runs: [RUN] }),
    });
    renderApp('/gardening');

    // The numbers rather than a verdict: a rule that read four hundred items
    // and found two is a different answer from one that never ran.
    expect(await screen.findByText(/read 412, found 2, filed 2/i)).toBeInTheDocument();
    // Inside the table, because the hint above it also mentions the schedule:
    // this is the run's own answer to who asked for it.
    expect(within(screen.getByRole('table')).getByText('the schedule')).toBeInTheDocument();
  });

  it('says which cap held a rule back, and that the run stopped at one', async () => {
    mockApi({
      ...signedIn(),
      'GET /v1/admin/gardening.settings': () => json({ settings: { ...OFF, enabled: true } }),
      'GET /v1/admin/gardening.runs': () =>
        json({
          runs: [
            {
              ...RUN,
              findings_filed: 20,
              reached_cap: true,
              rules: [{ ...RUN.rules[0], found: 48, filed: 20, limited: 'run_cap' as const }],
            },
          ],
        }),
    });
    renderApp('/gardening');

    expect(await screen.findByText(/the run was full/i)).toBeInTheDocument();
    expect(screen.getByText(/stopped at the cap/i)).toBeInTheDocument();
  });

  it('says a run never finished rather than showing it as one that found nothing', async () => {
    mockApi({
      ...signedIn(),
      'GET /v1/admin/gardening.settings': () => json({ settings: { ...OFF, enabled: true } }),
      'GET /v1/admin/gardening.runs': () =>
        json({ runs: [{ ...RUN, finished_at: null, findings_filed: 0, rules: [] }] }),
    });
    renderApp('/gardening');

    expect(await screen.findByText(/did not finish/i)).toBeInTheDocument();
  });

  it('shows what went wrong on the run it went wrong on', async () => {
    mockApi({
      ...signedIn(),
      'GET /v1/admin/gardening.settings': () => json({ settings: { ...OFF, enabled: true } }),
      'GET /v1/admin/gardening.runs': () =>
        json({ runs: [{ ...RUN, error: 'the database went away' }] }),
    });
    renderApp('/gardening');

    expect(await screen.findByText(/the database went away/i)).toBeInTheDocument();
  });
});

describe('somebody who may not administer the workspace', () => {
  it('sees the state and neither control', async () => {
    const client = renderApp.bind(null);
    mockApi({
      ...signedIn(['knowledge.read']),
      'GET /v1/admin/gardening.settings': () => json({ settings: { ...OFF, enabled: true } }),
      'GET /v1/admin/gardening.runs': () => json({ runs: [RUN] }),
    });
    const queries = client('/gardening');
    await settled(queries);

    // What somebody may do comes from the server, not from their role
    // (WEB_UI.md rule 5), and the page is worth reading either way.
    expect(await screen.findByText(/read 412, found 2, filed 2/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /run one now/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^save$/i })).not.toBeInTheDocument();
    expect(screen.getByText(/needs workspace administration/i)).toBeInTheDocument();
  });

  it('is not offered the section in the navigation at all', async () => {
    const client = renderApp.bind(null);
    mockApi({
      ...signedIn(['knowledge.read']),
      'GET /v1/knowledge_index': () => json({ items: [], total: 0 }),
    });
    const queries = client('/');
    await settled(queries);

    // A section whose every request the server refuses is not shown: offering
    // it would make a refusal the normal state of the application.
    expect(screen.queryByRole('link', { name: /gardening/i })).not.toBeInTheDocument();
  });
});
