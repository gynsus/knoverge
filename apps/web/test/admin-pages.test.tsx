import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AgentsResponse,
  MembersResponse,
  PolicyRulesResponse,
  MeResponse,
  TaxonomyListResponse,
  WorkspaceResponse,
} from '@knoverge/contracts';

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
  const calls: { url: string; method: string; body: unknown; workspace?: string }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET';
      const headers = new Headers(init?.headers);
      calls.push({
        url,
        method,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        ...(headers.get('x-knoverge-workspace')
          ? { workspace: headers.get('x-knoverge-workspace') as string }
          : {}),
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

/** Everything an owner holds, which is what these fixtures sign in as. */
const OWNER_PERMISSIONS = [
  'taxonomy.read',
  'taxonomy.propose',
  'taxonomy.manage',
  'knowledge.read',
  'knowledge.read_history',
  'knowledge.search',
  'knowledge.propose_create',
  'knowledge.propose_update',
  'knowledge.propose_delete',
  'knowledge.propose_supersede',
  'knowledge.write',
  'knowledge.approve',
  'proposal.read_all',
  'proposal.read_own',
  'events.read_all',
  'events.read_own',
  'agent.manage',
  'policy.manage',
  'workspace.admin',
];

const REVIEWER_PERMISSIONS = OWNER_PERMISSIONS.filter(
  (a) => !['agent.manage', 'policy.manage', 'workspace.admin', 'taxonomy.manage'].includes(a),
);

const SIGNED_IN_WORKSPACE = {
  id: ME.memberships[0]!.workspace_id,
  slug: 'personal',
  name: 'Personal',
  description: null,
  default_language: 'en',
  created_at: '2026-09-19T00:00:00.000Z',
  role: 'owner',
};

const SIGNED_IN: Record<string, Handler> = {
  'GET /v1/auth/status': () => json({ bootstrap_required: false, authenticated: true }),
  'GET /v1/auth/me': () => json(ME),
  'GET /v1/auth/csrf': () => json({ token: 'csrf-token' }),
  // The shell asks what the caller may do before it decides what to show.
  'GET /v1/workspace.get': () =>
    json({ workspace: SIGNED_IN_WORKSPACE, permissions: OWNER_PERMISSIONS }),
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

// The fixtures below stand in for real responses, so they are parsed through the
// contracts: a schema change fails these tests instead of silently passing them.
describe('fixtures match the contracts', () => {
  it('parses every canned response', () => {
    expect(() => MeResponse.parse(ME)).not.toThrow();
    expect(() => AgentsResponse.parse({ agents: [AGENT] })).not.toThrow();
    expect(() =>
      TaxonomyListResponse.parse({ taxonomy_version: 1, categories: [CATEGORY] }),
    ).not.toThrow();
  });
});

beforeEach(() => {
  resetCsrfToken();
  // The chosen workspace and the rail's state are remembered per browser, so
  // without this each test inherits whatever the one before it clicked.
  window.localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe('agents page', () => {
  it('lists agents and registers a new one', async () => {
    const agents = [AGENT];
    const calls = mockApi({
      ...SIGNED_IN,
      'GET /v1/admin/agents.list': () => json({ agents }),
      'POST /v1/admin/agents.create': () => {
        agents.push({ ...AGENT, id: 'ag_01J8Z3M4Q9V0X7K2B5N6P8R1T4', name: 'Cursor' });
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

    // The instruction is announced; the secret itself is deliberately outside
    // the live region, so a screen reader does not read the token aloud.
    const announced = await screen.findByRole('status');
    expect(announced).toHaveTextContent('shown once');
    expect(within(announced).queryByText(token)).not.toBeInTheDocument();
    expect(screen.getByText(token)).toBeInTheDocument();

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

describe('workspace page', () => {
  const WORKSPACE = SIGNED_IN_WORKSPACE;
  const MEMBERS = [
    {
      user_id: ME.user.id,
      actor_id: 'act_01J8Z3M4Q9V0X7K2B5N6P8R1T3',
      email: 'owner@example.com',
      display_name: 'Owner',
      role: 'owner',
      status: 'active',
      joined_at: '2026-09-19T00:00:00.000Z',
      last_login_at: '2026-09-19T00:00:00.000Z',
    },
    {
      // Somebody else: the signed-in person's own row offers no role change
      // and no removal, because the server refuses both.
      user_id: 'usr_01J8Z3M4Q9V0X7K2B5N6P8R1T4',
      actor_id: 'act_01J8Z3M4Q9V0X7K2B5N6P8R1T4',
      email: 'second@example.com',
      display_name: 'Second',
      role: 'reviewer',
      status: 'active',
      joined_at: '2026-09-19T00:00:00.000Z',
      last_login_at: null,
    },
  ];

  it('matches the contracts', () => {
    expect(() =>
      WorkspaceResponse.parse({ workspace: WORKSPACE, permissions: OWNER_PERMISSIONS }),
    ).not.toThrow();
    expect(() => MembersResponse.parse({ members: MEMBERS })).not.toThrow();
  });

  it('shows settings and members, and updates the workspace', async () => {
    const calls = mockApi({
      ...SIGNED_IN,
      'GET /v1/workspace.get': () => json({ workspace: WORKSPACE, permissions: OWNER_PERMISSIONS }),
      'GET /v1/admin/members.list': () => json({ members: MEMBERS }),
      'POST /v1/admin/workspace.update': () => json({ ok: true }),
    });
    renderApp('/workspace');
    expect(await screen.findByDisplayValue('Personal')).toBeInTheDocument();
    expect(screen.getByText('owner@example.com')).toBeInTheDocument();

    const user = userEvent.setup();
    await user.clear(screen.getByLabelText('Name'));
    await user.type(screen.getByLabelText('Name'), 'Personal Knowledge');
    await user.selectOptions(screen.getByLabelText('Default content language'), 'ru');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Workspace updated');
    expect(calls.find((c) => c.url === '/v1/admin/workspace.update')?.body).toMatchObject({
      name: 'Personal Knowledge',
      default_language: 'ru',
    });
  });

  it('adds a member with an initial password', async () => {
    const members = [...MEMBERS];
    const calls = mockApi({
      ...SIGNED_IN,
      'GET /v1/workspace.get': () => json({ workspace: WORKSPACE, permissions: OWNER_PERMISSIONS }),
      'GET /v1/admin/members.list': () => json({ members }),
      'POST /v1/admin/members.add': () => {
        members.push({
          ...MEMBERS[0]!,
          user_id: 'usr_2',
          email: 'member@example.com',
          display_name: 'Member',
          role: 'reviewer',
        });
        return json({ members });
      },
    });
    renderApp('/workspace');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Email'), 'member@example.com');
    await user.type(screen.getByLabelText('Initial password'), 'a long enough passphrase');
    await user.click(screen.getByRole('button', { name: 'Add member' }));
    expect(await screen.findByText('member@example.com')).toBeInTheDocument();
    expect(calls.find((c) => c.url === '/v1/admin/members.add')?.body).toMatchObject({
      email: 'member@example.com',
      role: 'reviewer',
      initial_password: 'a long enough passphrase',
    });
  });

  it('holds a role change until it is applied, and confirms a removal', async () => {
    const members = [...MEMBERS];
    const calls = mockApi({
      ...SIGNED_IN,
      'GET /v1/workspace.get': () => json({ workspace: WORKSPACE, permissions: OWNER_PERMISSIONS }),
      'GET /v1/admin/members.list': () => json({ members }),
      'POST /v1/admin/members.update': () => json({ ok: true }),
      'POST /v1/admin/members.remove': () => json({ ok: true }),
    });
    renderApp('/workspace');
    const user = userEvent.setup();
    const select = await screen.findByLabelText(`Role of ${MEMBERS[1]!.display_name}`);

    // Choosing a role changes nothing on its own: it used to be committed on
    // the change event, and the control then reverted while the call was in
    // flight.
    await user.selectOptions(select, 'viewer');
    expect(select).toHaveValue('viewer');
    expect(calls.find((c) => c.url === '/v1/admin/members.update')).toBeUndefined();

    await user.click(screen.getByRole('button', { name: 'Apply role' }));
    expect(calls.find((c) => c.url === '/v1/admin/members.update')?.body).toMatchObject({
      role: 'viewer',
    });

    // Removal asks first, and does nothing until the second press.
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    expect(calls.find((c) => c.url === '/v1/admin/members.remove')).toBeUndefined();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(calls.find((c) => c.url === '/v1/admin/members.remove')).toBeUndefined();
  });

  it('hides member management from a member who cannot administer', async () => {
    mockApi({
      ...SIGNED_IN,
      'GET /v1/workspace.get': () =>
        json({ workspace: { ...WORKSPACE, role: 'reviewer' }, permissions: REVIEWER_PERMISSIONS }),
    });
    renderApp('/workspace');
    expect(await screen.findByDisplayValue('Personal')).toBeDisabled();
    expect(screen.queryByText('Members')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });
});

describe('choosing a workspace', () => {
  const SECOND = {
    workspace_id: 'ws_01J8Z3M4Q9V0X7K2B5N6P8R1T9',
    workspace_slug: 'team',
    workspace_name: 'Team',
    role: 'admin',
  };
  const twoWorkspaces = { ...ME, memberships: [...ME.memberships, SECOND] };

  it('names the workspace on every request, and lets the person change it', async () => {
    // Without the header the server refuses a person who belongs to more than
    // one workspace, so every page failed for them with a validation error
    // about a header they cannot see.
    const calls = mockApi({
      ...SIGNED_IN,
      'GET /v1/auth/me': () => json(twoWorkspaces),
      'GET /v1/admin/members.list': () => json({ members: [] }),
    });
    renderApp('/');
    await screen.findByText('Your workspaces');
    const scoped = calls.filter((c) => c.url === '/v1/workspace.get');
    expect(scoped.length).toBeGreaterThan(0);
    expect(scoped.every((c) => c.workspace === ME.memberships[0]!.workspace_id)).toBe(true);

    const user = userEvent.setup();
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Workspace' }),
      SECOND.workspace_id,
    );
    await waitFor(() =>
      expect(
        calls.some((c) => c.url === '/v1/workspace.get' && c.workspace === SECOND.workspace_id),
      ).toBe(true),
    );
  });

  it("does not keep one workspace's rows on screen under the other's name", async () => {
    // The page keys are not scoped by workspace, so a switch that left the
    // cache alone showed the previous workspace's categories under the new
    // name — and acting on a row would have posted its id with the new header.
    const calls = mockApi({
      ...SIGNED_IN,
      'GET /v1/auth/me': () => json(twoWorkspaces),
      'GET /v1/taxonomy.list?include_archived=true': (_url, init) =>
        json({
          categories: [
            {
              ...CATEGORY,
              name:
                new Headers(init?.headers).get('x-knoverge-workspace') === SECOND.workspace_id
                  ? 'Team projects'
                  : 'Projects',
            },
          ],
          taxonomy_version: 1,
        }),
    });
    renderApp('/taxonomy');
    await screen.findByRole('button', { name: 'Projects' });

    const user = userEvent.setup();
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Workspace' }),
      SECOND.workspace_id,
    );
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.url === '/v1/taxonomy.list?include_archived=true' &&
            c.workspace === SECOND.workspace_id,
        ),
      ).toBe(true),
    );
    expect(await screen.findByRole('button', { name: 'Team projects' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Projects' })).not.toBeInTheDocument();
    expect(
      calls.filter(
        (c) =>
          c.url === '/v1/taxonomy.list?include_archived=true' &&
          c.workspace === SECOND.workspace_id,
      ).length,
    ).toBeGreaterThan(0);
  });

  it('offers no picker to a person who belongs to one workspace', async () => {
    mockApi({ ...SIGNED_IN, 'GET /v1/admin/members.list': () => json({ members: [] }) });
    renderApp('/');
    await screen.findByText('Your workspaces');
    expect(screen.queryByRole('combobox', { name: 'Workspace' })).not.toBeInTheDocument();
  });
});

describe('the shell', () => {
  it('names the current section in a heading of its own', async () => {
    // Every page heading is an h2 from a card title. Without this each page is
    // a flat run of h2s under no level-1 heading, and nothing names the page.
    mockApi({ ...SIGNED_IN });
    renderApp('/taxonomy');
    expect(await screen.findByRole('heading', { level: 1, name: 'Taxonomy' })).toBeInTheDocument();
  });

  it('keeps the way out reachable when the rail is collapsed', async () => {
    // The footer holds the only sign-out control, and the collapsed state is
    // remembered, so hiding it locked a person out of signing out for good.
    mockApi({ ...SIGNED_IN });
    renderApp('/');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Show or hide the navigation' }));
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeVisible();
  });
});

describe('what the interface offers', () => {
  it('hides the sections whose every request would be refused', async () => {
    // A reviewer holds none of agent.manage, policy.manage or taxonomy.manage.
    mockApi({
      ...SIGNED_IN,
      'GET /v1/workspace.get': () =>
        json({
          workspace: { ...SIGNED_IN_WORKSPACE, role: 'reviewer' },
          permissions: REVIEWER_PERMISSIONS,
        }),
    });
    renderApp('/');
    await screen.findByText('Your workspaces');
    // Waits for the permissions to arrive before judging what is shown.
    expect(await screen.findByRole('link', { name: 'Taxonomy' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Agents' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Policy' })).not.toBeInTheDocument();
  });

  it('shows a section to somebody granted it, whatever their role says', async () => {
    mockApi({
      ...SIGNED_IN,
      'GET /v1/workspace.get': () =>
        json({
          workspace: { ...SIGNED_IN_WORKSPACE, role: 'reviewer' },
          // The grant is what decides, not the role. Deriving this from the
          // role showed a reviewer a disabled form they were entitled to use.
          permissions: [...REVIEWER_PERMISSIONS, 'agent.manage'],
        }),
    });
    renderApp('/');
    await screen.findByText('Your workspaces');
    expect(await screen.findByRole('link', { name: 'Agents' })).toBeInTheDocument();
  });
});

describe('policy page', () => {
  const RULE = {
    id: 'rule_01J8Z3M4Q9V0X7K2B5N6P8R1T3',
    workspace_id: ME.memberships[0]!.workspace_id,
    priority: 10,
    subject: { trust_tier: 'trusted' },
    action: 'knowledge.update',
    scope: { categories: [], types: [], languages: [] },
    effect: 'require_review',
    enabled: true,
    created_at: '2026-09-19T00:00:00.000Z',
  };

  it('matches the contract', () => {
    expect(() => PolicyRulesResponse.parse({ rules: [RULE] })).not.toThrow();
  });

  it('describes a rule in words rather than field names', async () => {
    mockApi({ ...SIGNED_IN, 'GET /v1/admin/policy.rules': () => json({ rules: [RULE] }) });
    renderApp('/policy');
    // It used to print "trust_tier: trusted" into both catalogues.
    expect(await screen.findByText('Trust tier: Trusted')).toBeInTheDocument();
    expect(screen.queryByText(/trust_tier:/)).not.toBeInTheDocument();
  });

  it('creates a rule, which is the only way an agent write is ever applied directly', async () => {
    const calls = mockApi({
      ...SIGNED_IN,
      'GET /v1/admin/policy.rules': () => json({ rules: [] }),
      'POST /v1/admin/policy.rules.upsert': () => json({ rule: RULE }),
    });
    renderApp('/policy');
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'New rule' });
    await user.selectOptions(screen.getByLabelText('Decision'), 'allow_direct');
    await user.click(screen.getByRole('button', { name: 'Create rule' }));
    await waitFor(() =>
      expect(calls.find((c) => c.url === '/v1/admin/policy.rules.upsert')?.body).toMatchObject({
        subject: { trust_tier: 'trusted' },
        action: 'knowledge.update',
        effect: 'allow_direct',
        enabled: true,
      }),
    );
  });

  it('edits an existing rule by its id', async () => {
    const calls = mockApi({
      ...SIGNED_IN,
      'GET /v1/admin/policy.rules': () => json({ rules: [RULE] }),
      'POST /v1/admin/policy.rules.upsert': () => json({ rule: RULE }),
    });
    renderApp('/policy');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    await user.click(await screen.findByRole('button', { name: 'Save rule' }));
    await waitFor(() =>
      expect(calls.find((c) => c.url === '/v1/admin/policy.rules.upsert')?.body).toMatchObject({
        rule_id: RULE.id,
      }),
    );
  });
});

describe('editing a category', () => {
  const ROOT = {
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
  const CHILD = {
    ...ROOT,
    id: 'cat_01J8Z3M4Q9V0X7K2B5N6P8R1T4',
    parent_id: ROOT.id,
    slug: 'web',
    path: 'projects/web',
    name: 'Web',
  };

  it('sends every field the contract allows, not only the name', async () => {
    const calls = mockApi({
      ...SIGNED_IN,
      'GET /v1/taxonomy.list?include_archived=true': () =>
        json({ taxonomy_version: 1, categories: [ROOT] }),
      'POST /v1/admin/taxonomy.update': () => json({ taxonomy_version: 2, category: ROOT }),
    });
    renderApp('/taxonomy');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Projects' }));
    await user.type(screen.getByLabelText('Description'), 'Client work');
    await user.type(screen.getByLabelText('What belongs here'), 'Anything with a client');
    await user.type(screen.getByLabelText('Other names'), 'Clients, Work');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls.find((c) => c.url === '/v1/admin/taxonomy.update')?.body).toMatchObject({
        category_id: ROOT.id,
        description: 'Client work',
        inclusion_guidance: ['Anything with a client'],
        aliases: ['Clients', 'Work'],
      }),
    );
  });

  it('moves a category to any parent, not only to the top level', async () => {
    const calls = mockApi({
      ...SIGNED_IN,
      'GET /v1/taxonomy.list?include_archived=true': () =>
        json({ taxonomy_version: 1, categories: [ROOT, CHILD] }),
      'POST /v1/admin/taxonomy.move': () => json({ taxonomy_version: 2, category: CHILD }),
    });
    renderApp('/taxonomy');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Web' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Move under' }), ROOT.id);
    await waitFor(() =>
      expect(calls.find((c) => c.url === '/v1/admin/taxonomy.move')?.body).toMatchObject({
        category_id: CHILD.id,
        new_parent_id: ROOT.id,
      }),
    );
  });
});

describe('managing an agent', () => {
  const DISABLED = { ...AGENT, status: 'disabled' };

  it('changes a trust tier and brings a disabled agent back', async () => {
    let agent: Record<string, unknown> = DISABLED;
    const calls = mockApi({
      ...SIGNED_IN,
      'GET /v1/admin/agents.list': () => json({ agents: [agent] }),
      'GET /v1/admin/agents.credentials.list': () => json({ credentials: [] }),
      'POST /v1/admin/agents.update': () => {
        agent = { ...agent, status: 'active' };
        return json({ agent });
      },
    });
    renderApp('/agents');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Manage' }));
    // A disabled agent could never be brought back from the browser.
    await user.click(screen.getByRole('button', { name: 'Enable agent' }));
    await waitFor(() =>
      expect(calls.find((c) => c.url === '/v1/admin/agents.update')?.body).toMatchObject({
        status: 'active',
      }),
    );
  });
});

describe('the navigation rail', () => {
  it('keeps the label of every entry, so a collapsed rail is still readable', async () => {
    mockApi(SIGNED_IN);
    renderApp('/');
    // The tooltip is for a pointer and a touch screen has none, so the label
    // stays in the markup rather than being replaced by one.
    const taxonomy = await screen.findByRole('link', { name: 'Taxonomy' });
    expect(taxonomy).toHaveAccessibleName('Taxonomy');
    expect(screen.getByRole('button', { name: 'Show or hide the navigation' })).toBeInTheDocument();
  });

  it('marks the page you are on', async () => {
    mockApi({ ...SIGNED_IN, 'GET /v1/admin/agents.list': () => json({ agents: [] }) });
    renderApp('/agents');
    const agents = await screen.findByRole('link', { name: 'Agents' });
    expect(agents).toHaveAttribute('data-active', 'true');
  });

  it('remembers whether it was open, without telling the server', async () => {
    // The generated component keeps this in a cookie, which is sent with every
    // request for no reason.
    window.localStorage.setItem('knoverge.sidebar', 'false');
    mockApi(SIGNED_IN);
    renderApp('/');
    await screen.findByRole('link', { name: 'Overview' });
    expect(document.cookie).not.toContain('sidebar');
  });

  it('shows no rail to somebody who is not signed in', async () => {
    mockApi({
      'GET /v1/auth/status': () => json({ bootstrap_required: false, authenticated: false }),
      'GET /v1/auth/csrf': () => json({ token: 'csrf-token' }),
    });
    renderApp('/login');
    await screen.findByRole('heading', { name: 'Sign in' });
    expect(screen.queryByRole('link', { name: 'Overview' })).not.toBeInTheDocument();
  });
});

describe('where the language is chosen', () => {
  it('is on the settings page, not in the chrome of every page', async () => {
    mockApi({
      ...SIGNED_IN,
      'GET /v1/account/sessions': () => json({ sessions: [] }),
    });
    renderApp('/settings');
    expect(await screen.findByRole('combobox', { name: 'Language' })).toBeInTheDocument();
  });

  it('is not on another signed-in page', async () => {
    mockApi(SIGNED_IN);
    renderApp('/');
    await screen.findByText('Your workspaces');
    expect(screen.queryByRole('combobox', { name: 'Language' })).not.toBeInTheDocument();
  });

  it('stays on the sign-in page, where there are no settings to go to', async () => {
    mockApi({
      'GET /v1/auth/status': () => json({ bootstrap_required: false, authenticated: false }),
      'GET /v1/auth/csrf': () => json({ token: 'csrf-token' }),
    });
    renderApp('/login');
    await screen.findByRole('heading', { name: 'Sign in' });
    expect(screen.getByRole('combobox', { name: 'Language' })).toBeInTheDocument();
  });
});

describe('a form leaves room around its button', () => {
  it('separates the submit button from the last field on every form', async () => {
    // The forms written by hand had a gap and the ones migrated mechanically
    // did not, so a button sat against the field above it.
    mockApi({
      ...SIGNED_IN,
      'GET /v1/taxonomy.list?include_archived=true': () =>
        json({ taxonomy_version: 0, categories: [] }),
    });
    renderApp('/taxonomy');
    const submit = await screen.findByRole('button', { name: 'Add category' });
    const form = submit.closest('form');
    expect(form?.className).toContain('gap-4');
    // And it is not stretched across the card by the grid it sits in.
    expect(submit.className).toContain('justify-self-start');
  });
});

describe('a checkbox is a checkbox', () => {
  it('renders the rule toggle as one, with a label beside it', async () => {
    // The migration turned every input into the text Input, which made this a
    // full-width text box with a tick floating in the middle of it.
    mockApi({ ...SIGNED_IN, 'GET /v1/admin/policy.rules': () => json({ rules: [] }) });
    renderApp('/policy');
    const enabled = await screen.findByRole('checkbox', { name: 'Enabled' });
    expect(enabled).toBeChecked();
    const user = userEvent.setup();
    await user.click(enabled);
    expect(enabled).not.toBeChecked();
  });
});

describe('a subheading stands apart from the fields under it', () => {
  it('is a real legend, set apart from the first label', async () => {
    mockApi({ ...SIGNED_IN, 'GET /v1/account/sessions': () => json({ sessions: [] }) });
    renderApp('/settings');
    const legend = await screen.findByText('Change password', { selector: 'legend' });
    // A legend takes no part in the grid gap, so its spacing has to be its own.
    expect(legend.className).toContain('mb-3');
    // And it reads as a heading rather than as another field label.
    expect(legend.className).toContain('font-semibold');
  });
});

describe('knowledge page', () => {
  const ITEM = {
    id: 'kn_01J8Z3M4Q9V0X7K2B5N6P8R1T3',
    workspace_id: ME.memberships[0]!.workspace_id,
    slug: 'authentication-strategy',
    markdown_path: 'knowledge/architecture/authentication-strategy.md',
    title: 'Authentication strategy',
    type: 'decision',
    status: 'active',
    language: 'en',
    current_revision_id: 'rev_01J8Z3M4Q9V0X7K2B5N6P8R1T3',
    review_state: 'human_reviewed',
    evidence_state: 'none',
    disputed: false,
    categories: ['architecture'],
    tags: ['auth'],
    valid_from: null,
    valid_until: null,
    observed_at: null,
    created_at: '2026-09-19T00:00:00.000Z',
    updated_at: '2026-09-19T00:00:00.000Z',
  };
  const DETAIL = {
    ...ITEM,
    body: 'Passwordless login uses a six-digit email code.\n',
    sources: [],
    relations: [],
    content_hash: 'sha256:' + 'a'.repeat(64),
    frontmatter_hash: 'sha256:' + 'b'.repeat(64),
    revision_number: 1,
  };
  const ROUTES = {
    ...SIGNED_IN,
    'GET /v1/knowledge.list': () => json({ items: [ITEM], next_cursor: null }),
    [`GET /v1/knowledge.get?item_id=${ITEM.id}`]: () => json({ item: DETAIL }),
    [`GET /v1/knowledge.revisions?item_id=${ITEM.id}`]: () =>
      json({
        revisions: [
          {
            id: DETAIL.current_revision_id,
            revision_number: 1,
            change_kind: 'create',
            title: ITEM.title,
            markdown_path: ITEM.markdown_path,
            content_hash: DETAIL.content_hash,
            frontmatter_hash: DETAIL.frontmatter_hash,
            git_commit: 'c'.repeat(40),
            actor_id: 'act_01J8Z3M4Q9V0X7K2B5N6P8R1T3',
            created_at: '2026-09-19T00:00:00.000Z',
          },
        ],
      }),
  };

  it('opens an item and sends the revision it was based on', async () => {
    const calls = mockApi({
      ...ROUTES,
      'POST /v1/admin/knowledge.update': () => json({ item: { ...DETAIL, revision_number: 2 } }),
    });
    renderApp('/knowledge');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: ITEM.title }));

    // Scoped to the editor: the form for a new item carries the same labels,
    // which is why both are named regions.
    const editor = within(await screen.findByRole('region', { name: ITEM.title }));
    const body = editor.getByLabelText('Text');
    await user.clear(body);
    await user.type(body, 'Rewritten.');
    await user.click(editor.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(calls.find((c) => c.url === '/v1/admin/knowledge.update')).toBeTruthy(),
    );
    // Rule 6: an edit says what it was based on, so the server can refuse it
    // rather than overwrite somebody else's work.
    expect(calls.find((c) => c.url === '/v1/admin/knowledge.update')?.body).toMatchObject({
      item_id: ITEM.id,
      base_revision_id: DETAIL.current_revision_id,
      base_content_hash: DETAIL.content_hash,
    });
  });

  it('tells the person when somebody else changed the item first', async () => {
    mockApi({
      ...ROUTES,
      'POST /v1/admin/knowledge.update': () =>
        json(
          {
            code: 'REVISION_CONFLICT',
            message: 'the item changed since you read it',
            retryable: false,
          },
          409,
        ),
    });
    renderApp('/knowledge');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: ITEM.title }));
    const editor = within(await screen.findByRole('region', { name: ITEM.title }));
    await user.click(editor.getByRole('button', { name: 'Save' }));

    // A conflict is the one answer this page must not swallow — and it is
    // shown from the catalogue by error code, not as the server's own wording.
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Someone changed this while you were editing. Reload and try again.',
    );
  });
});

const PROPOSAL = {
  id: 'prop_01J8Z3M4Q9V0X7K2B5N6P8R1T3',
  workspace_id: ME.memberships[0]!.workspace_id,
  proposal_type: 'knowledge_update' as const,
  status: 'pending' as const,
  target_item_id: 'kn_01J8Z3M4Q9V0X7K2B5N6P8R1T3',
  proposed_by_actor_id: 'act_01J8Z3M4Q9V0X7K2B5N6P8R1T3',
  base_revision_id: 'rev_01J8Z3M4Q9V0X7K2B5N6P8R1T3',
  base_content_hash: 'sha256:abc',
  reason: 'The source changed.',
  confidence: 0.8,
  policy_decision: 'require_review' as const,
  created_at: '2026-09-21T00:00:00.000Z',
  resolved_at: null,
  resolved_by_actor_id: null,
  resolution_note: null,
  result_revision_ids: [],
};

const ITEM = {
  id: PROPOSAL.target_item_id,
  workspace_id: ME.memberships[0]!.workspace_id,
  slug: 'release-cadence',
  markdown_path: 'knowledge/release-cadence.md',
  title: 'Release cadence',
  type: 'fact' as const,
  status: 'active' as const,
  language: 'en',
  current_revision_id: PROPOSAL.base_revision_id,
  review_state: 'human_reviewed' as const,
  evidence_state: 'none' as const,
  disputed: false,
  categories: [],
  tags: [],
  valid_from: null,
  valid_until: null,
  observed_at: null,
  created_at: '2026-09-19T00:00:00.000Z',
  updated_at: '2026-09-19T00:00:00.000Z',
  body: 'We release on Thursdays.\n',
  sources: [],
  relations: [],
  content_hash: 'sha256:abc',
  frontmatter_hash: 'sha256:def',
  revision_number: 1,
};

describe('review inbox', () => {
  it('shows what a proposal would change, and approves it', async () => {
    const calls = mockApi({
      ...SIGNED_IN,
      'GET /v1/proposal.list?status=pending': () => json({ proposals: [PROPOSAL] }),
      [`GET /v1/proposal.get?proposal_id=${PROPOSAL.id}`]: () =>
        json({
          proposal: { ...PROPOSAL, proposed_payload: { body: 'We release on Tuesdays.' } },
        }),
      [`GET /v1/knowledge.get?item_id=${ITEM.id}`]: () => json({ item: ITEM }),
      'POST /v1/proposal_approve': () =>
        json({ proposal: { ...PROPOSAL, status: 'approved' }, item_id: ITEM.id }),
    });
    renderApp('/review');

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'The source changed.' }));

    const detail = await screen.findByRole('region', { name: /Change|Release/ });
    // The reviewer sees the old line going and the new one arriving, rather
    // than being asked to approve a diff nobody read.
    await waitFor(() => expect(detail.textContent).toContain('- We release on Thursdays.'));
    expect(detail.textContent).toContain('+ We release on Tuesdays.');
    expect(detail.textContent).toContain('The source changed.');

    await user.click(within(detail).getByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith('/v1/proposal_approve'))).toBe(true),
    );
    const approval = calls.find((c) => c.url.endsWith('/v1/proposal_approve'))!;
    expect(approval.body).toMatchObject({ proposal_id: PROPOSAL.id });
    // Nothing was edited, so nothing is sent as an edit.
    expect((approval.body as Record<string, unknown>)['edits']).toBeUndefined();
  });

  it('sends the reviewer’s text when they changed it, and their reason on a rejection', async () => {
    const calls = mockApi({
      ...SIGNED_IN,
      'GET /v1/proposal.list?status=pending': () => json({ proposals: [PROPOSAL] }),
      [`GET /v1/proposal.get?proposal_id=${PROPOSAL.id}`]: () =>
        json({
          proposal: { ...PROPOSAL, proposed_payload: { body: 'We release on Tuesdays.' } },
        }),
      [`GET /v1/knowledge.get?item_id=${ITEM.id}`]: () => json({ item: ITEM }),
      'POST /v1/proposal_reject': () =>
        json({ proposal: { ...PROPOSAL, status: 'rejected' }, item_id: null }),
    });
    renderApp('/review');

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'The source changed.' }));
    const detail = await screen.findByRole('region', { name: /Change|Release/ });

    await user.type(within(detail).getByLabelText('Note'), 'Already in the handbook.');
    await user.click(within(detail).getByRole('button', { name: 'Reject' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith('/v1/proposal_reject'))).toBe(true),
    );
    expect(calls.find((c) => c.url.endsWith('/v1/proposal_reject'))!.body).toMatchObject({
      proposal_id: PROPOSAL.id,
      reason: 'Already in the handbook.',
    });
  });

  it('is not offered to somebody who cannot approve', async () => {
    mockApi({
      ...SIGNED_IN,
      'GET /v1/workspace.get': () =>
        json({
          workspace: SIGNED_IN_WORKSPACE,
          permissions: OWNER_PERMISSIONS.filter((a) => a !== 'knowledge.approve'),
        }),
      'GET /v1/knowledge.list': () => json({ items: [], next_cursor: null }),
    });
    renderApp('/knowledge');
    await screen.findByRole('heading', { name: 'Knowledge' });
    expect(screen.queryByRole('link', { name: 'Review' })).toBeNull();
  });
});
