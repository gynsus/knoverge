import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
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

const AGENT = {
  id: 'ag_01J8Z3M4Q9V0X7K2B5N6P8R1T3',
  workspace_id: ME.memberships[0]!.workspace_id,
  actor_id: 'act_01J8Z3M4Q9V0X7K2B5N6P8R1T3',
  name: 'Claude Code',
  description: null,
  client_type: 'claude-code',
  trust_tier: 'propose',
  status: 'active',
  created_at: '2026-09-19T00:00:00.000Z',
  last_seen_at: null,
  active_credentials: 0,
};

const CATEGORY = {
  id: 'cat_01J8Z3M4Q9V0X7K2B5N6P8R1T3',
  workspace_id: ME.memberships[0]!.workspace_id,
  parent_id: null,
  slug: 'projects',
  path: 'projects',
  name: 'Projects',
  description: null,
  inclusion_guidance: [],
  exclusion_guidance: [],
  aliases: [],
  status: 'active',
  created_at: '2026-09-19T00:00:00.000Z',
  updated_at: '2026-09-19T00:00:00.000Z',
  item_count: 0,
  subtree_item_count: 0,
};

const SIGNED_IN: Record<string, Handler> = {
  'GET /v1/auth/status': () => json({ bootstrap_required: false, authenticated: true }),
  'GET /v1/auth/me': () => json(ME),
  'GET /v1/auth/csrf': () => json({ token: 'csrf-token' }),
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

beforeEach(() => resetCsrfToken());
afterEach(() => vi.unstubAllGlobals());

describe('agents page', () => {
  it('lists agents and registers a new one', async () => {
    const agents = [AGENT];
    const calls = mockApi({
      ...SIGNED_IN,
      'GET /v1/admin/agents.list': () => json({ agents }),
      'POST /v1/admin/agents.create': () => {
        agents.push({ ...AGENT, id: 'ag_2', name: 'Cursor' });
        return json({ agent: agents[1] });
      },
    });
    renderApp('/agents');
    expect(await screen.findByText('Claude Code')).toBeInTheDocument();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Name'), 'Cursor');
    await user.click(screen.getByRole('button', { name: 'Register agent' }));
    expect(await screen.findByText('Cursor')).toBeInTheDocument();
    expect(calls.find((c) => c.url === '/v1/admin/agents.create')?.body).toMatchObject({
      name: 'Cursor',
      trust_tier: 'propose',
    });
  });

  it('shows an issued token exactly once and never in the listing', async () => {
    const token = 'knv_01J8Z3M4Q9V0_secretsecretsecretsecretsecretsecretse';
    const credentials: unknown[] = [];
    mockApi({
      ...SIGNED_IN,
      'GET /v1/admin/agents.list': () => json({ agents: [AGENT] }),
      [`GET /v1/admin/agents.credentials?agent_id=${AGENT.id}`]: () => json({ credentials }),
      'POST /v1/admin/agents.credentials.issue': () => {
        credentials.push({
          id: 'cred_1',
          agent_id: AGENT.id,
          token_prefix: '01J8Z3M4Q9V0',
          label: null,
          created_at: '2026-09-19T00:00:00.000Z',
          expires_at: null,
          revoked_at: null,
          last_used_at: null,
        });
        return json({ credential: credentials[0], token });
      },
    });
    renderApp('/agents');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Manage' }));
    await user.click(screen.getByRole('button', { name: 'Issue token' }));

    const notice = await screen.findByRole('alert');
    expect(within(notice).getByText(token)).toBeInTheDocument();
    expect(notice).toHaveTextContent('shown once');

    expect(screen.getByText('01J8Z3M4Q9V0')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Hide token' }));
    expect(screen.queryByText(token)).not.toBeInTheDocument();
  });

  it('reports a refused request through the catalogue', async () => {
    mockApi({
      ...SIGNED_IN,
      'GET /v1/admin/agents.list': () =>
        json({ code: 'FORBIDDEN', message: 'not permitted: agent.manage', retryable: false }, 403),
    });
    renderApp('/agents');
    expect(await screen.findByRole('alert')).toHaveTextContent('This action is not allowed.');
  });
});

describe('taxonomy page', () => {
  it('shows the tree with its version and adds a category', async () => {
    const categories = [CATEGORY];
    const calls = mockApi({
      ...SIGNED_IN,
      'GET /v1/taxonomy.list?include_archived=true': () =>
        json({ taxonomy_version: categories.length, categories }),
      'POST /v1/admin/taxonomy.create': () => {
        categories.push({
          ...CATEGORY,
          id: 'cat_2',
          slug: 'career',
          path: 'career',
          name: 'Career',
        });
        return json({ taxonomy_version: categories.length, category: categories[1] });
      },
    });
    renderApp('/taxonomy');
    expect(await screen.findByRole('button', { name: 'Projects' })).toBeInTheDocument();
    expect(screen.getByText('version 1')).toBeInTheDocument();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Name'), 'Career');
    await user.selectOptions(screen.getByLabelText('Parent'), 'projects');
    await user.click(screen.getByRole('button', { name: 'Add category' }));
    expect(await screen.findByRole('button', { name: 'Career' })).toBeInTheDocument();
    expect(calls.find((c) => c.url === '/v1/admin/taxonomy.create')?.body).toMatchObject({
      name: 'Career',
      parent_path: 'projects',
    });
  });
});

describe('settings page', () => {
  it('changes the password and lists sessions', async () => {
    const calls = mockApi({
      ...SIGNED_IN,
      'GET /v1/auth/sessions': () =>
        json({
          sessions: [
            {
              id: ME.session.id,
              created_at: '2026-09-19T00:00:00.000Z',
              expires_at: '2026-10-19T00:00:00.000Z',
              user_agent: 'Firefox',
              ip: '127.0.0.1',
              current: true,
            },
          ],
        }),
      'POST /v1/auth/password': () => json({ ok: true }),
    });
    renderApp('/settings');
    expect(await screen.findByText('Firefox')).toBeInTheDocument();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Current password'), 'correct horse battery');
    await user.type(screen.getByLabelText('New password'), 'an entirely new passphrase');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Password changed');
    expect(calls.find((c) => c.url === '/v1/auth/password')?.body).toMatchObject({
      current_password: 'correct horse battery',
      new_password: 'an entirely new passphrase',
    });
  });
});
