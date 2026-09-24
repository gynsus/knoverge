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
  KnowledgeListResponse,
  ProposalsResponse,
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
      workspace_archived_at: null,
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
  created_by_actor_id: 'act_01J8Z3M4Q9V0X7K2B5N6P8R1T3',
  approved_by_actor_id: null,
  merged_into_category_id: null,
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
  archived_at: null,
  role: 'owner',
};

const SIGNED_IN: Record<string, Handler> = {
  'GET /v1/auth/status': () => json({ bootstrap_required: false, authenticated: true }),
  'GET /v1/auth/me': () => json(ME),
  'GET /v1/auth/csrf': () => json({ token: 'csrf-token' }),
  // The shell asks what the caller may do before it decides what to show.
  'GET /v1/workspace.get': () =>
    json({ workspace: SIGNED_IN_WORKSPACE, permissions: OWNER_PERMISSIONS }),
  'GET /v1/actors.list': () =>
    json({
      actors: [
        {
          id: 'act_01J8Z3M4Q9V0X7K2B5N6P8R1T3',
          type: 'human',
          display_name: 'Owner',
          agent_id: null,
          disabled: false,
        },
      ],
    }),
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
    // The form is asked for rather than occupying the page.
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Register an agent' }));
    await user.type(await screen.findByLabelText('Name'), 'Cursor');
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
    await user.click(await screen.findByRole('button', { name: 'Claude Code' }));
    await user.click(await screen.findByRole('button', { name: 'Issue token' }));

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
  it('shows the tree with its version and adds a category through the sheet', async () => {
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
    // The form is asked for rather than occupying the page: before this there
    // is nothing on screen but the tree and its toolbar.
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'New category' }));
    await user.type(await screen.findByLabelText('Name'), 'Career');
    await user.click(screen.getByRole('button', { name: 'Create category' }));

    expect(await screen.findByRole('button', { name: 'Career' })).toBeInTheDocument();
    expect(calls.find((c) => c.url === '/v1/admin/taxonomy.create')?.body).toMatchObject({
      name: 'Career',
    });
  });

  it('searches names, paths, aliases and descriptions, and keeps the ancestors', async () => {
    const parent = {
      ...CATEGORY,
      id: 'cat_p',
      slug: 'projects',
      path: 'projects',
      name: 'Projects',
    };
    const child = {
      ...CATEGORY,
      id: 'cat_c',
      parent_id: 'cat_p',
      slug: 'architecture',
      path: 'projects/architecture',
      name: 'Architecture',
      description: 'Authentication and system layout.',
    };
    const other = { ...CATEGORY, id: 'cat_o', slug: 'career', path: 'career', name: 'Career' };
    mockApi({
      ...SIGNED_IN,
      'GET /v1/taxonomy.list?include_archived=true': () =>
        json({ taxonomy_version: 3, categories: [parent, child, other] }),
    });
    renderApp('/taxonomy');
    const user = userEvent.setup();
    await screen.findByRole('button', { name: 'Projects' });

    // A word that appears only in a description, three levels from the root.
    await user.type(screen.getByLabelText(/Search names/), 'authentication');
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Career' })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: 'Architecture' })).toBeInTheDocument();
    // Its parent stays, or the match would hang from nothing and the tree
    // would have lost the one thing it is for.
    expect(screen.getByRole('button', { name: 'Projects' })).toBeInTheDocument();
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
              user_agent:
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/130.0',
              ip: '127.0.0.1',
              current: true,
            },
          ],
        }),
      'POST /v1/auth/password': () => json({ ok: true }),
    });
    renderApp('/settings/security');
    // The raw user agent is the truth and not the answer: somebody reading
    // their own sessions is asking which of these is the laptop.
    expect(await screen.findByText(/Firefox 130/)).toBeInTheDocument();

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
      archived_at: null,
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

  it('lists the members of the workspace somebody is in', async () => {
    mockApi({
      ...SIGNED_IN,
      'GET /v1/workspace.get': () => json({ workspace: WORKSPACE, permissions: OWNER_PERMISSIONS }),
      'GET /v1/admin/members.list': () => json({ members: MEMBERS }),
    });
    renderApp('/workspaces/members');
    expect(await screen.findByText('owner@example.com')).toBeInTheDocument();
    // The workspace's own settings are not here. They are edited in the
    // drawer on the list, where every workspace is, rather than on a page
    // that could only ever change the one somebody happened to be in.
    expect(screen.queryByLabelText('Default content language')).not.toBeInTheDocument();
  });

  it('sends somebody to the members page from the address that used to be settings', async () => {
    mockApi({
      ...SIGNED_IN,
      'GET /v1/workspace.get': () => json({ workspace: WORKSPACE, permissions: OWNER_PERMISSIONS }),
      'GET /v1/admin/members.list': () => json({ members: MEMBERS }),
    });
    renderApp('/workspaces/settings');
    expect(await screen.findByRole('heading', { level: 2, name: 'Members' })).toBeInTheDocument();
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
    renderApp('/workspaces/settings');
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
    renderApp('/workspaces/settings');
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
    renderApp('/workspaces/members');
    // It says why rather than showing an empty page: the server refuses
    // members.list without workspace.admin, so there is nothing to show and
    // somebody is owed a reason.
    expect(
      await screen.findByText('Membership is managed by the workspace owner.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add member' })).not.toBeInTheDocument();
  });
});

describe('choosing a workspace', () => {
  const SECOND = {
    workspace_id: 'ws_01J8Z3M4Q9V0X7K2B5N6P8R1T9',
    workspace_slug: 'team',
    workspace_name: 'Team',
    workspace_archived_at: null,
    role: 'admin',
  };
  const twoWorkspaces = { ...ME, memberships: [...ME.memberships, SECOND] };

  /** Opens the switcher and chooses a workspace by name. */
  async function switchTo(user: ReturnType<typeof userEvent.setup>, name: string) {
    await user.click(await screen.findByRole('button', { name: /Current workspace:/ }));
    await user.click(await screen.findByRole('menuitemradio', { name: new RegExp(name) }));
  }

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
    await switchTo(user, 'Team');
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
    await switchTo(user, 'Team');
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

  it('still names the workspace to a person who belongs to one', async () => {
    // The switcher is not hidden below two workspaces. It says where somebody
    // is, and it is where the second workspace is made from; a control that
    // appears only once a second one exists is one nobody finds.
    mockApi({ ...SIGNED_IN, 'GET /v1/admin/members.list': () => json({ members: [] }) });
    renderApp('/');
    await screen.findByText('Your workspaces');
    expect(screen.getByRole('button', { name: /Current workspace: Personal/ })).toBeInTheDocument();
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
    // The form is asked for rather than occupying the page below the rules.
    expect(screen.queryByLabelText('Decision')).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'New rule' }));
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

  it('keeps deleting out of reach of an accidental click', async () => {
    // A destructive control standing beside every row is pressed by accident
    // eventually. It lives in the menu, and the menu has to be opened.
    mockApi({ ...SIGNED_IN, 'GET /v1/admin/policy.rules': () => json({ rules: [RULE] }) });
    renderApp('/policy');
    const user = userEvent.setup();
    await screen.findByRole('button', { name: 'Trust tier: Trusted' });
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).toBeNull();
    await user.click(
      screen.getByRole('button', {
        name: 'Actions for the rule that applies to Trust tier: Trusted',
      }),
    );
    expect(await screen.findByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
  });

  it('edits an existing rule by its id', async () => {
    const calls = mockApi({
      ...SIGNED_IN,
      'GET /v1/admin/policy.rules': () => json({ rules: [RULE] }),
      'POST /v1/admin/policy.rules.upsert': () => json({ rule: RULE }),
    });
    renderApp('/policy');
    const user = userEvent.setup();
    // The card itself opens the rule: the whole card is the control, and the
    // menu beside it is for the things that are not "look at this".
    await user.click(await screen.findByRole('button', { name: 'Trust tier: Trusted' }));
    await user.click(await screen.findByRole('button', { name: 'Save rule' }));
    await waitFor(() =>
      expect(calls.find((c) => c.url === '/v1/admin/policy.rules.upsert')?.body).toMatchObject({
        rule_id: RULE.id,
      }),
    );
  });
});

describe('the taxonomy toolbar', () => {
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
    created_by_actor_id: 'act_01J8Z3M4Q9V0X7K2B5N6P8R1T3',
    approved_by_actor_id: null,
    merged_into_category_id: null,
  };

  it('says how big the tree is, and how much of it a search found', async () => {
    // A search changes the tree in place, and nothing else on the screen
    // would say it had shrunk.
    mockApi({
      ...SIGNED_IN,
      'GET /v1/taxonomy.list?include_archived=true': () =>
        json({
          taxonomy_version: 1,
          categories: [
            CATEGORY,
            {
              ...CATEGORY,
              id: 'cat_01J8Z3M4Q9V0X7K2B5N6P8R1T9',
              slug: 'people',
              path: 'people',
              name: 'People',
            },
          ],
        }),
    });
    renderApp('/taxonomy');
    const user = userEvent.setup();
    await screen.findByRole('button', { name: 'People' });
    const count = () => screen.getByRole('status').textContent;
    expect(count()).toContain('2 categories');
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();

    await user.type(
      screen.getByLabelText('Search names, paths, aliases and descriptions'),
      'people',
    );
    await waitFor(() => expect(count()).toContain('1 matches the search'));
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(count()).toContain('2 categories'));
  });
});

describe('categories an agent has asked for', () => {
  const PROPOSED = {
    id: 'prop_01J8Z3M4Q9V0X7K2B5N6P8R1TA',
    workspace_id: ME.memberships[0]!.workspace_id,
    proposal_type: 'category_create' as const,
    status: 'pending' as const,
    title: 'Data Governance',
    categories: [],
    target_item_id: null,
    proposed_by_actor_id: 'act_01J8Z3M4Q9V0X7K2B5N6P8R1T3',
    base_revision_id: null,
    base_content_hash: null,
    reason: 'Nothing distinguishes ownership from retention.',
    confidence: null,
    policy_decision: 'require_review' as const,
    created_at: '2026-09-21T00:00:00.000Z',
    resolved_at: null,
    resolved_by_actor_id: null,
    resolution_note: null,
    result_revision_ids: [],
    sync_session_id: null,
  };
  const DATA_MODEL = {
    id: 'cat_01J8Z3M4Q9V0X7K2B5N6P8R1TB',
    workspace_id: ME.memberships[0]!.workspace_id,
    parent_id: null,
    slug: 'data-model',
    path: 'data-model',
    name: 'Data Model',
    description: null,
    inclusion_guidance: [],
    exclusion_guidance: [],
    aliases: [],
    status: 'active',
    created_at: '2026-09-19T00:00:00.000Z',
    updated_at: '2026-09-19T00:00:00.000Z',
    item_count: 0,
    subtree_item_count: 0,
    created_by_actor_id: 'act_01J8Z3M4Q9V0X7K2B5N6P8R1T3',
    approved_by_actor_id: null,
    merged_into_category_id: null,
  };

  it('shows them above the tree, with the case for each one', async () => {
    mockApi({
      ...SIGNED_IN,
      'GET /v1/taxonomy.list?include_archived=true': () =>
        json({ taxonomy_version: 1, categories: [DATA_MODEL] }),
      'GET /v1/proposal.list?status=pending': () => json({ proposals: [PROPOSED] }),
      [`GET /v1/proposal.get?proposal_id=${PROPOSED.id}`]: () =>
        json({
          proposal: {
            ...PROPOSED,
            proposed_payload: {
              name: 'Data Governance',
              parentPath: null,
              description: null,
              exampleTitles: ['Backup retention policy', 'Attachment ownership'],
            },
          },
        }),
    });
    renderApp('/taxonomy');
    const user = userEvent.setup();
    // A proposed category is not in the tree: it has no path and no place
    // among the real ones, and putting it there would claim it exists.
    await user.click(await screen.findByRole('button', { name: /Data Governance/ }));

    expect(
      await screen.findByText('Nothing distinguishes ownership from retention.'),
    ).toBeInTheDocument();
    // The case for a category is the material that has nowhere else to go.
    expect(screen.getByText('Backup retention policy')).toBeInTheDocument();
    // And the collision this view exists to catch, named in the panel rather
    // than only standing in the tree.
    expect(screen.getByText('Categories that sound close')).toBeInTheDocument();
    expect(screen.getByText('data-model')).toBeInTheDocument();
  });

  it('offers what works and says what does not', async () => {
    // Approving a category proposal does not make the category yet, so the
    // button that exists is the one that works.
    mockApi({
      ...SIGNED_IN,
      'GET /v1/taxonomy.list?include_archived=true': () =>
        json({ taxonomy_version: 1, categories: [DATA_MODEL] }),
      'GET /v1/proposal.list?status=pending': () => json({ proposals: [PROPOSED] }),
      [`GET /v1/proposal.get?proposal_id=${PROPOSED.id}`]: () =>
        json({
          proposal: {
            ...PROPOSED,
            proposed_payload: {
              name: 'Data Governance',
              parentPath: null,
              description: null,
              exampleTitles: [],
            },
          },
        }),
    });
    renderApp('/taxonomy');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Data Governance/ }));
    expect(await screen.findByRole('button', { name: 'Create this category' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.getByText(/does not make the category yet/)).toBeInTheDocument();

    // Creating starts from what was proposed rather than from an empty form.
    await user.click(screen.getByRole('button', { name: 'Create this category' }));
    expect(await screen.findByDisplayValue('Data Governance')).toBeInTheDocument();
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
    created_by_actor_id: 'act_01J8Z3M4Q9V0X7K2B5N6P8R1T3',
    approved_by_actor_id: null,
    merged_into_category_id: null,
  };
  const CHILD = {
    ...ROOT,
    id: 'cat_01J8Z3M4Q9V0X7K2B5N6P8R1T4',
    parent_id: ROOT.id,
    slug: 'web',
    path: 'projects/web',
    name: 'Web',
  };
  const OTHER = {
    ...ROOT,
    id: 'cat_01J8Z3M4Q9V0X7K2B5N6P8R1T5',
    slug: 'archive',
    path: 'archive',
    name: 'Archive',
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
    await user.click(await screen.findByRole('button', { name: 'Actions for Projects' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit' }));

    await user.type(await screen.findByLabelText('Description'), 'Client work');
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

  it('says what a move will do before it does it', async () => {
    const calls = mockApi({
      ...SIGNED_IN,
      'GET /v1/taxonomy.list?include_archived=true': () =>
        json({ taxonomy_version: 1, categories: [ROOT, CHILD, OTHER] }),
      'POST /v1/admin/taxonomy.move': () => json({ taxonomy_version: 2, category: CHILD }),
    });
    renderApp('/taxonomy');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Actions for Web' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Move' }));

    // The dialog names the path it is leaving before anything is chosen.
    expect(await screen.findByText('projects/web')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'New parent' }));
    await user.click(await screen.findByRole('option', { name: /Archive/ }));
    // The new path is worked out and shown before anything is sent.
    expect(await screen.findByText('archive/web')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Move' }));

    await waitFor(() =>
      expect(calls.find((c) => c.url === '/v1/admin/taxonomy.move')?.body).toMatchObject({
        category_id: CHILD.id,
        new_parent_id: OTHER.id,
      }),
    );
  });

  it('folds one category into another and says what moves', async () => {
    const calls = mockApi({
      ...SIGNED_IN,
      'GET /v1/taxonomy.list?include_archived=true': () =>
        json({ taxonomy_version: 1, categories: [ROOT, CHILD] }),
      'POST /v1/admin/taxonomy.merge': () => json({ taxonomy_version: 2, category: ROOT }),
    });
    renderApp('/taxonomy');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Actions for Web' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Merge' }));

    await user.click(await screen.findByRole('button', { name: 'Into' }));
    await user.click(await screen.findByRole('option', { name: /Projects/ }));
    // The one word on this screen that sounds reversible and is not, so what
    // happens to the closed name is on screen at the moment of the click.
    expect(await screen.findByText(/becomes an alias/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Merge' }));

    await waitFor(() =>
      expect(calls.find((c) => c.url === '/v1/admin/taxonomy.merge')?.body).toMatchObject({
        category_id: CHILD.id,
        into_category_id: ROOT.id,
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
    await user.click(await screen.findByRole('button', { name: 'Claude Code' }));
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
    // A real landmark around them. Without it the shortcut every screen
    // reader offers for "take me to the navigation" lands nowhere, and the
    // links can only be reached by walking the page from the top.
    const rail = screen.getByRole('navigation', { name: 'Sections' });
    expect(rail).toContainElement(taxonomy);
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

describe('the settings catalogue', () => {
  it('separates what is yours from what is the installation\u2019s', async () => {
    // One long canvas is how a settings page becomes unreadable. The split is
    // by whose settings they are, which is also the boundary that matters:
    // one of them is the same on every workspace and the other is not.
    mockApi(SIGNED_IN);
    renderApp('/settings');
    expect(await screen.findByText('Yours')).toBeInTheDocument();
    expect(screen.getByText('This installation')).toBeInTheDocument();
  });

  it('shows a section that does not exist yet, and does not pretend it does', async () => {
    // Hiding it would let somebody looking for backups conclude they are in
    // the wrong place. A card that says "Not yet" answers the question.
    mockApi(SIGNED_IN);
    renderApp('/settings');
    const card = (await screen.findByText('Data and storage')).closest('li') as HTMLElement;
    expect(within(card).getByText('Not yet')).toBeInTheDocument();
    expect(within(card).queryByRole('link')).toBeNull();
  });

  it('goes to a section that does', async () => {
    mockApi({ ...SIGNED_IN, 'GET /v1/account/sessions': () => json({ sessions: [] }) });
    renderApp('/settings');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('link', { name: 'Security' }));
    expect(await screen.findByLabelText('Current password')).toBeInTheDocument();
  });
});

describe('where the language is chosen', () => {
  it('is on the settings page, not in the chrome of every page', async () => {
    mockApi({
      ...SIGNED_IN,
      'GET /v1/account/sessions': () => json({ sessions: [] }),
    });
    renderApp('/settings/account');
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
    mockApi({ ...SIGNED_IN, 'GET /v1/admin/members.list': () => json({ members: [] }) });
    renderApp('/workspaces/members');
    const submit = await screen.findByRole('button', { name: 'Add member' });
    const form = submit.closest('form');
    expect(form?.className).toContain('gap-4');
    // And it is not stretched across the card by the grid it sits in.
    expect(submit.className).toContain('justify-self-start');
  });
});

describe('choosing a category', () => {
  const CATEGORIES = {
    taxonomy_version: 1,
    categories: [CATEGORY],
  };

  /** jsdom reports 1024 by default; these tests say which side of it they want. */
  function widthOf(width: number) {
    const original = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    return () =>
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: original });
  }

  it('greys nothing out when the detail panel is a column', async () => {
    const restore = widthOf(1280);
    try {
      mockApi({
        ...SIGNED_IN,
        'GET /v1/taxonomy.list?include_archived=true': () => json(CATEGORIES),
      });
      const { baseElement } = renderApp('/taxonomy');
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: 'Projects' }));

      // The panel is on screen, in the column it belongs to.
      expect(await screen.findByRole('heading', { name: 'Projects', level: 3 })).toBeVisible();
      // And nothing is behind an overlay. A sheet hidden with a class still
      // draws one through a portal the class does not reach, and still locks
      // the page's scrolling, neither of which anybody can see.
      expect(baseElement.querySelector('[data-slot="sheet-overlay"]')).toBeNull();
      expect(document.body).not.toHaveAttribute('data-scroll-locked');
    } finally {
      restore();
    }
  });

  it('opens a sheet when there is no column for it', async () => {
    const restore = widthOf(800);
    try {
      mockApi({
        ...SIGNED_IN,
        'GET /v1/taxonomy.list?include_archived=true': () => json(CATEGORIES),
      });
      const { baseElement } = renderApp('/taxonomy');
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: 'Projects' }));

      await waitFor(() =>
        expect(baseElement.querySelector('[data-slot="sheet-overlay"]')).not.toBeNull(),
      );
      expect(await screen.findByRole('dialog')).toBeInTheDocument();
    } finally {
      restore();
    }
  });
});

describe('a checkbox is a checkbox', () => {
  it('renders the rule toggle as one, with a label beside it', async () => {
    // The migration turned every input into the text Input, which made this a
    // full-width text box with a tick floating in the middle of it.
    mockApi({ ...SIGNED_IN, 'GET /v1/admin/policy.rules': () => json({ rules: [] }) });
    renderApp('/policy?new');
    const enabled = await screen.findByRole('checkbox', { name: 'Enabled' });
    expect(enabled).toBeChecked();
    const user = userEvent.setup();
    await user.click(enabled);
    expect(enabled).not.toBeChecked();
  });
});

describe('changing your own name', () => {
  it('changes in place and asks for no password', async () => {
    // A display name is a label, not a credential. Asking for a secret to
    // correct a typo in your own name would buy nothing.
    const calls = mockApi({
      ...SIGNED_IN,
      'GET /v1/account/sessions': () => json({ sessions: [] }),
      'POST /v1/auth/profile': () =>
        json({ ...ME, user: { ...ME.user, display_name: 'Grigory F.' } }),
    });
    renderApp('/settings/account');
    const user = userEvent.setup();
    // Named for what it changes: two buttons reading "Change" are the same
    // word twice to anyone who hears them rather than sees the row.
    await user.click(await screen.findByRole('button', { name: 'Change name' }));
    const field = screen.getByLabelText('Your name');
    expect(screen.queryByLabelText('Your password')).not.toBeInTheDocument();
    await user.clear(field);
    await user.type(field, 'Grigory F.');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls.find((c) => c.url === '/v1/auth/profile')?.body).toEqual({
        display_name: 'Grigory F.',
      }),
    );
  });
});

describe('a group of fields is named once', () => {
  it('does not repeat the card title as a legend', async () => {
    // "Change password" as the card's title and again as the legend directly
    // under it is the same words twice in a row.
    mockApi({ ...SIGNED_IN, 'GET /v1/account/sessions': () => json({ sessions: [] }) });
    renderApp('/settings/security');
    await screen.findByLabelText('Current password');
    expect(screen.queryByText('Change password', { selector: 'legend' })).toBeNull();
    // The fieldset is still a fieldset, and the card still names the section.
    expect(screen.getByRole('heading', { name: 'Change password' })).toBeInTheDocument();
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
    revision_number: 1,
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
  const REVISION = {
    id: 'rev_01J8Z3M4Q9V0X7K2B5N6P8R1T3',
    revision_number: 1,
    change_kind: 'create' as const,
    title: 'Authentication strategy',
    markdown_path: 'knowledge/architecture/authentication-strategy.md',
    content_hash: 'sha256:' + 'a'.repeat(64),
    frontmatter_hash: 'sha256:' + 'b'.repeat(64),
    git_commit: 'c'.repeat(40),
    actor_id: 'act_01J8Z3M4Q9V0X7K2B5N6P8R1T3',
    created_at: '2026-09-19T00:00:00.000Z',
    reason: null,
  };
  const ROUTES = {
    ...SIGNED_IN,
    'GET /v1/knowledge.counts': () => json({ counts: { total: 1, unreviewed: 0, unsourced: 1 } }),
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

  it('has fixtures the contract accepts', () => {
    // Parsed rather than trusted: a field added to the contract has to be
    // added here too, and a row quietly missing it is a worse way to learn.
    expect(() => KnowledgeListResponse.parse({ items: [ITEM], next_cursor: null })).not.toThrow();
  });

  it('offers the piles a person works through, counted over the workspace', async () => {
    // A number describing the fifty rows that happen to be loaded, while
    // claiming to describe the workspace, is worse than no number.
    const calls = mockApi({
      ...ROUTES,
      'GET /v1/knowledge.counts': () =>
        json({ counts: { total: 186, unreviewed: 12, unsourced: 31 } }),
    });
    renderApp('/knowledge');
    const user = userEvent.setup();
    // Waits for the number, not just the name: the view works before the
    // count arrives, and the count is what this is about.
    const view = await screen.findByRole('button', { name: 'No sources' });
    await waitFor(() => expect(view.textContent).toContain('31'));

    await user.click(view);
    // Each count opens exactly the list it counted.
    await waitFor(() =>
      expect(calls.some((c) => c.url.includes('evidence_states=none'))).toBe(true),
    );
  });

  it('says where an item came from, and says it when nothing did', async () => {
    // Provenance is one of the things this product is for, so a bare badge
    // that cannot be acted on is the wrong end of it.
    mockApi({
      ...ROUTES,
      [`GET /v1/knowledge.get?item_id=${ITEM.id}`]: () =>
        json({
          item: {
            ...DETAIL,
            sources: [
              { type: 'web_url', role: 'primary', uri: 'https://example.com/adr-4' },
              { type: 'agent_session', role: 'supporting', client: 'claude-code' },
            ],
          },
        }),
    });
    renderApp(`/knowledge?item=${ITEM.id}`);
    const drawer = await screen.findByRole('dialog');
    expect(await within(drawer).findByText('https://example.com/adr-4')).toBeInTheDocument();
    // The role is what makes a source evidence rather than a link.
    expect(within(drawer).getByText('Supporting')).toBeInTheDocument();
  });

  it('names the items a connection points at, rather than printing ids', async () => {
    const other = { ...DETAIL, id: 'kn_01J8Z3M4Q9V0X7K2B5N6P8R1T9', title: 'The older decision' };
    mockApi({
      ...ROUTES,
      [`GET /v1/knowledge.get?item_id=${ITEM.id}`]: () =>
        json({
          item: {
            ...DETAIL,
            relations: [{ type: 'supersedes', target: other.id }],
          },
        }),
      [`GET /v1/knowledge.get?item_id=${other.id}`]: () => json({ item: other }),
    });
    renderApp(`/knowledge?item=${ITEM.id}`);
    const user = userEvent.setup();
    const drawer = await screen.findByRole('dialog');
    await user.click(await within(drawer).findByRole('tab', { name: /Connections/ }));
    // "supersedes kn_01J8..." tells a reader nothing they can act on.
    expect(await within(drawer).findByRole('button', { name: 'The older decision' })).toBeVisible();
    expect(within(drawer).getByText('Supersedes')).toBeInTheDocument();
  });

  it('sends the sources a reviewer added, and drops a connection left empty', async () => {
    const calls = mockApi({
      ...ROUTES,
      'POST /v1/admin/knowledge.update': () => json({ item: DETAIL }),
    });
    renderApp(`/knowledge?item=${ITEM.id}`);
    const user = userEvent.setup();
    const drawer = await screen.findByRole('dialog');
    await user.click(await within(drawer).findByRole('button', { name: 'Edit' }));

    await user.click(within(drawer).getByRole('button', { name: 'Add a source' }));
    await user.type(within(drawer).getByLabelText('Where it is'), 'https://example.com/adr-4');
    // Started and not finished: sending it would be refused, and dropping it
    // is what leaving a row empty already means.
    await user.click(within(drawer).getByRole('button', { name: 'Add a connection' }));
    await user.click(within(drawer).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith('/v1/admin/knowledge.update'))).toBe(true),
    );
    const body = calls.find((c) => c.url.endsWith('/v1/admin/knowledge.update'))!.body as Record<
      string,
      unknown
    >;
    expect(body['sources']).toEqual([
      { type: 'web_url', role: 'primary', uri: 'https://example.com/adr-4' },
    ]);
    expect(body['relations']).toEqual([]);
  });

  it('fetches what a revision changed only when somebody asks', async () => {
    // A history of forty revisions would be forty diffs nobody read, each one
    // two files out of Git.
    const second = 'rev_01J8Z3M4Q9V0X7K2B5N6P8R1T8';
    const calls = mockApi({
      ...ROUTES,
      [`GET /v1/knowledge.revisions?item_id=${ITEM.id}`]: () =>
        json({
          revisions: [
            {
              ...REVISION,
              id: second,
              revision_number: 2,
              change_kind: 'update',
              reason: 'Tightened the wording.',
            },
            REVISION,
          ],
        }),
      [`GET /v1/knowledge.diff?item_id=${ITEM.id}&from_revision_id=${REVISION.id}&to_revision_id=${second}`]:
        () =>
          json({
            from: REVISION,
            to: { ...REVISION, id: second, revision_number: 2 },
            body_diff: '-old line\n+new line',
            metadata_changes: [{ field: 'tags', from: ['auth'], to: ['auth', 'login'] }],
          }),
    });
    renderApp(`/knowledge?item=${ITEM.id}`);
    const user = userEvent.setup();
    const drawer = await screen.findByRole('dialog');
    await user.click(await within(drawer).findByRole('tab', { name: /History/ }));
    // The reason is the only thing the history has that says why.
    expect(await within(drawer).findByText('Tightened the wording.')).toBeInTheDocument();
    expect(calls.some((c) => c.url.includes('knowledge.diff'))).toBe(false);

    await user.click(within(drawer).getByRole('button', { name: 'See what changed' }));
    expect(await within(drawer).findByText('+new line')).toBeInTheDocument();
    // What changed about the item, answered rather than left in the patch.
    expect(within(drawer).getByText('auth, login')).toBeInTheDocument();
  });

  it('asks before dropping unsaved work, however the drawer is closed', async () => {
    // Cancel used to be the only way out that asked. The overlay, the close
    // button and Escape all dropped the work without a word.
    mockApi(ROUTES);
    renderApp(`/knowledge?item=${ITEM.id}`);
    const user = userEvent.setup();
    const drawer = await screen.findByRole('dialog');
    await user.click(await within(drawer).findByRole('button', { name: 'Edit' }));
    await user.type(within(drawer).getByLabelText('Title'), ' and more');

    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await user.click(within(drawer).getByRole('button', { name: 'Close' }));
    expect(confirm).toHaveBeenCalled();
    // Refused, so the work is still there.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    confirm.mockRestore();
  });

  it('walks the list with the arrows and opens what it lands on', async () => {
    mockApi(ROUTES);
    renderApp('/knowledge');
    const user = userEvent.setup();
    await screen.findByRole('button', { name: ITEM.title });
    await user.keyboard('{ArrowDown}');
    // Marked, or the arrows move nothing anybody can see.
    const row = screen.getByRole('button', { name: ITEM.title }).closest('li') as HTMLElement;
    expect(row).toHaveAttribute('aria-current', 'true');
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('shows what a reader needs and not the file path', async () => {
    // The path was the widest thing in every row and the least useful: at
    // seventy items it was most of what the eye had to skip past.
    mockApi(ROUTES);
    renderApp('/knowledge');

    const title = await screen.findByRole('button', { name: ITEM.title });
    expect(screen.queryByText(ITEM.markdown_path)).toBeNull();
    // What replaced it: where it sits, whether it was checked, whether it
    // rests on anything, and when it last moved.
    const row = within(title.closest('li') as HTMLElement);
    expect(row.getByText('architecture')).toBeInTheDocument();
    expect(row.getByText('Reviewed by a person')).toBeInTheDocument();
    expect(row.getByText('No sources')).toBeInTheDocument();
    // A ledger's rows say how far an item has moved.
    expect((title.closest('li') as HTMLElement).textContent).toContain('revision 1');
  });

  it('narrows on the server, from an address somebody can be sent', async () => {
    const calls = mockApi(ROUTES);
    renderApp('/knowledge?category=architecture&type=decision&state=unreviewed');

    // Narrowing in the browser would filter the page that happens to be
    // loaded, which answers a different question than the one asked.
    await waitFor(() => expect(calls.some((c) => c.url.includes('category_path'))).toBe(true));
    const url = calls.find((c) => c.url.includes('category_path'))!.url;
    expect(url).toContain('category_path=architecture');
    expect(url).toContain('types=decision');
    expect(url).toContain('review_states=unreviewed');
  });

  it('asks search when there is a query, and browse when there is not', async () => {
    const calls = mockApi({
      ...ROUTES,
      'POST /v1/knowledge_search': () =>
        json({
          results: [
            {
              item_id: ITEM.id,
              title: ITEM.title,
              type: ITEM.type,
              status: 'active',
              language: 'en',
              review_state: ITEM.review_state,
              evidence_state: ITEM.evidence_state,
              disputed: false,
              category_paths: ITEM.categories,
              revision_id: ITEM.current_revision_id,
              content_hash: DETAIL.content_hash,
              updated_at: ITEM.updated_at,
              score: 1,
              score_components: { title: 1, lexical: 1 },
              snippet: 'Passwordless login',
            },
          ],
        }),
    });
    renderApp('/knowledge?q=passwordless');

    await waitFor(() => expect(calls.some((c) => c.url === '/v1/knowledge_search')).toBe(true));
    expect(calls.find((c) => c.url === '/v1/knowledge_search')?.body).toMatchObject({
      query: 'passwordless',
    });
    // A ranked answer replaces the browse list rather than being merged into
    // it: the two are ordered by different things.
    expect(calls.some((c) => c.url.startsWith('/v1/knowledge.list'))).toBe(false);
    expect(await screen.findByRole('button', { name: ITEM.title })).toBeInTheDocument();
  });

  it('says nothing matches rather than showing an empty list', async () => {
    mockApi({
      ...ROUTES,
      'GET /v1/knowledge.list?category_path=architecture': () =>
        json({ items: [], next_cursor: null }),
    });
    renderApp('/knowledge?category=architecture');
    expect(await screen.findByText('Nothing matches')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getAllByRole('button', { name: 'Clear filters' })[0]!);
    expect(await screen.findByRole('button', { name: ITEM.title })).toBeInTheDocument();
  });

  it('opens for reading, and edits only when asked', async () => {
    // Every change here is a revision and a Git commit. Opening an item used
    // to put the fields on the screen straight away, which answers "what may
    // I change?" when the question was "what does this say?".
    mockApi(ROUTES);
    renderApp('/knowledge');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: ITEM.title }));

    const drawer = within(await screen.findByRole('dialog', { name: ITEM.title }));
    expect(await drawer.findByText(DETAIL.body.trim())).toBeInTheDocument();
    expect(drawer.queryByLabelText('Text')).toBeNull();
    // The path lives here, where somebody asked for the item, rather than in
    // every row of the list.
    expect(drawer.getByText(ITEM.markdown_path)).toBeInTheDocument();

    await user.click(drawer.getByRole('button', { name: 'Edit' }));
    expect(drawer.getByLabelText('Text')).toBeInTheDocument();
    // And deleting is not one button away from saving.
    expect(drawer.queryByRole('button', { name: 'Delete' })).toBeNull();
  });

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
    const editor = within(await screen.findByRole('dialog', { name: ITEM.title }));
    await user.click(await editor.findByRole('button', { name: 'Edit' }));
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
    const editor = within(await screen.findByRole('dialog', { name: ITEM.title }));
    await user.click(await editor.findByRole('button', { name: 'Edit' }));
    const body = editor.getByLabelText('Text');
    await user.type(body, ' Changed.');
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
  title: 'Release cadence',
  categories: ['architecture/constraints'],
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
  sync_session_id: null,
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
  it('has fixtures the contract accepts', () => {
    // Parsed rather than trusted: a field added to the contract has to be
    // added here too, and a crash in a page is a worse way to find that out.
    expect(() => ProposalsResponse.parse({ proposals: [PROPOSAL] })).not.toThrow();
  });

  it('opens the proposal from an address somebody can be sent', async () => {
    // A reviewer has to be able to send somebody the proposal rather than the
    // queue it is somewhere in.
    mockApi({
      ...SIGNED_IN,
      'GET /v1/proposal.list?status=pending': () => json({ proposals: [PROPOSAL] }),
      'GET /v1/proposal.list?status=conflict': () => json({ proposals: [] }),
      [`GET /v1/proposal.get?proposal_id=${PROPOSAL.id}`]: () =>
        json({ proposal: { ...PROPOSAL, proposed_payload: { body: 'We release on Tuesdays.' } } }),
      [`GET /v1/knowledge.get?item_id=${ITEM.id}`]: () => json({ item: ITEM }),
    });
    renderApp(`/review?proposal=${PROPOSAL.id}`);

    // Arrived open, because the address said so. Beside the queue rather than
    // over it: this is a queue somebody works down, and a drawer would cost an
    // open and a close for every decision (WEB_UI.md rule 1).
    expect(await screen.findByRole('region', { name: 'Release cadence' })).toBeVisible();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says why each proposal is waiting, which is what frames the decision', async () => {
    mockApi({
      ...SIGNED_IN,
      'GET /v1/proposal.list?status=pending': () => json({ proposals: [PROPOSAL] }),
      'GET /v1/proposal.list?status=conflict': () => json({ proposals: [] }),
      [`GET /v1/proposal.get?proposal_id=${PROPOSAL.id}`]: () =>
        json({ proposal: { ...PROPOSAL, proposed_payload: { body: 'We release on Tuesdays.' } } }),
      [`GET /v1/knowledge.get?item_id=${ITEM.id}`]: () => json({ item: ITEM }),
    });
    renderApp(`/review?proposal=${PROPOSAL.id}`);
    const detail = await screen.findByRole('region', { name: 'Release cadence' });
    // `policy_decision: require_review` is why this one is here.
    expect(detail.textContent).toContain('Policy asks for a person to review');
    // Provenance decides an agent proposal, so its absence is stated rather
    // than left as a section that is simply not there.
    expect(detail.textContent).toContain('Nothing here says where this came from');
  });

  it('counts the piles, and the count is also the filter', async () => {
    const stuck = {
      ...PROPOSAL,
      id: 'prop_01J8Z3M4Q9V0X7K2B5N6P8R1T4',
      status: 'conflict' as const,
      title: 'Stuck one',
    };
    mockApi({
      ...SIGNED_IN,
      'GET /v1/proposal.list?status=pending': () => json({ proposals: [PROPOSAL] }),
      'GET /v1/proposal.list?status=conflict': () => json({ proposals: [stuck] }),
    });
    renderApp('/review');
    const user = userEvent.setup();
    // Both are in the queue: everything unresolved belongs here.
    expect(await screen.findByRole('button', { name: /Release cadence/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Stuck one/ })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^Conflicts/ }));
    expect(screen.queryByRole('button', { name: /Release cadence/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Stuck one/ })).toBeInTheDocument();
  });

  it('says who proposed each one, by name rather than by id', async () => {
    mockApi({
      ...SIGNED_IN,
      'GET /v1/proposal.list?status=pending': () => json({ proposals: [PROPOSAL] }),
      'GET /v1/proposal.list?status=conflict': () => json({ proposals: [] }),
    });
    renderApp('/review');
    // A queue of ninety from one import is unreadable without it.
    const queue = await screen.findByRole('list', { name: 'The review queue' });
    expect(within(queue).getByText('Owner')).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(PROPOSAL.proposed_by_actor_id))).toBeNull();
  });

  it('shows what a proposal would change, and approves it', async () => {
    const calls = mockApi({
      ...SIGNED_IN,
      'GET /v1/proposal.list?status=pending': () => json({ proposals: [PROPOSAL] }),
      'GET /v1/proposal.list?status=conflict': () => json({ proposals: [] }),
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
    await user.click(await screen.findByRole('button', { name: /Release cadence/ }));

    const detail = await screen.findByRole('region', { name: 'Release cadence' });
    // The reviewer sees the old line going and the new one arriving, rather
    // than being asked to approve a diff nobody read.
    await waitFor(() => expect(detail.textContent).toContain('- We release on Thursdays.'));
    expect(detail.textContent).toContain('+ We release on Tuesdays.');
    expect(detail.textContent).toContain('The source changed.');
    // Read first: the panel opens showing the proposal, not a form.
    expect(within(detail).queryByLabelText('Text')).toBeNull();

    await user.click(within(detail).getByRole('button', { name: 'Approve as it is' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith('/v1/proposal_approve'))).toBe(true),
    );
    const approval = calls.find((c) => c.url.endsWith('/v1/proposal_approve'))!;
    expect(approval.body).toMatchObject({ proposal_id: PROPOSAL.id });
    // Nothing was edited, so nothing is sent as an edit.
    expect((approval.body as Record<string, unknown>)['edits']).toBeUndefined();
  });

  it('offers only the fields the proposal carries, once editing is asked for', async () => {
    // An update that changes the body and nothing else carries no title, and
    // an empty title box beside it reads as the proposal taking the title away.
    mockApi({
      ...SIGNED_IN,
      'GET /v1/proposal.list?status=pending': () => json({ proposals: [PROPOSAL] }),
      'GET /v1/proposal.list?status=conflict': () => json({ proposals: [] }),
      [`GET /v1/proposal.get?proposal_id=${PROPOSAL.id}`]: () =>
        json({ proposal: { ...PROPOSAL, proposed_payload: { body: 'We release on Tuesdays.' } } }),
      [`GET /v1/knowledge.get?item_id=${ITEM.id}`]: () => json({ item: ITEM }),
    });
    renderApp(`/review?proposal=${PROPOSAL.id}`);
    const user = userEvent.setup();
    const detail = await screen.findByRole('region', { name: 'Release cadence' });
    await user.click(within(detail).getByRole('button', { name: 'Edit before approving' }));
    expect(within(detail).getByLabelText('Text')).toBeInTheDocument();
    expect(within(detail).queryByLabelText('Title')).toBeNull();
  });

  it('asks why on a rejection, and sends what was said', async () => {
    const calls = mockApi({
      ...SIGNED_IN,
      'GET /v1/proposal.list?status=pending': () => json({ proposals: [PROPOSAL] }),
      'GET /v1/proposal.list?status=conflict': () => json({ proposals: [] }),
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
    await user.click(await screen.findByRole('button', { name: /Release cadence/ }));
    const detail = await screen.findByRole('region', { name: 'Release cadence' });

    // Rejecting asks why. "Rejected, no reason given" teaches an agent
    // nothing about what to do differently.
    await user.click(within(detail).getByRole('button', { name: 'Reject' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(
      within(dialog).getByLabelText('What to tell the proposer'),
      'Already in the handbook.',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Reject' }));
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
