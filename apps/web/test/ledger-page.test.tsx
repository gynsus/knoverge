import { ActivityDigestResponse, EventType, EventsListResponse } from '@knoverge/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetCsrfToken, setWorkspace } from '../src/api/client.ts';
import { App } from '../src/App.tsx';
import { GROUPS, typesIn } from '../src/components/ledger/groups.ts';
import { createI18n, resources } from '../src/i18n.ts';

type Handler = (body: unknown) => Response;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Every request the page made, so a test can read what it asked for. */
type Asked = { url: string; body: unknown }[];

function mockApi(routes: Record<string, Handler>): Asked {
  const asked: Asked = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      asked.push({ url, body });
      const handler = routes[`${init?.method ?? 'GET'} ${url}`];
      return handler
        ? handler(body)
        : json({ code: 'NOT_FOUND', message: `no mock for ${url}`, retryable: false }, 404);
    }),
  );
  return asked;
}

const WORKSPACE = 'ws_01J8Z3M4Q9V0X7K2B5N6P8R1T3';
const ACTOR = 'act_01J8Z3M4Q9V0X7K2B5N6P8R1T3';
const AGENT_ACTOR = 'act_01J8Z3M4Q9V0X7K2B5N6P8R1T4';

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
      workspace_archived_at: null,
      role: 'owner',
    },
  ],
  session: { id: 'sess_01J8Z3M4Q9V0X7K2B5N6P8R1T3', expires_at: '2026-10-19T00:00:00.000Z' },
};

const ACTORS = {
  actors: [
    { id: ACTOR, type: 'user', display_name: 'Owner', agent_id: null, disabled: false },
    {
      id: AGENT_ACTOR,
      type: 'agent',
      display_name: 'Claude Code',
      agent_id: 'ag_01J8Z3M4Q9V0X7K2B5N6P8R1T3',
      disabled: false,
    },
  ],
};

const ITEM = 'kn_01J8Z3M4Q9V0X7K2B5N6P8R1T3';
const PROPOSAL = 'prop_01J8Z3M4Q9V0X7K2B5N6P8R1T3';

const DIGEST = {
  since: '2026-09-20T00:00:00.000Z',
  until: '2026-09-27T00:00:00.000Z',
  counts: [
    { event_type: 'knowledge.updated', count: 4 },
    { event_type: 'proposal.approved', count: 2 },
  ],
  changed_items: [
    {
      item_id: ITEM,
      title: 'Authentication strategy',
      change_kinds: ['updated'],
      last_changed_at: '2026-09-26T09:00:00.000Z',
      revision_id: 'rev_01J8Z3M4Q9V0X7K2B5N6P8R1T3',
    },
  ],
  resolved_proposals: [
    {
      proposal_id: PROPOSAL,
      status: 'approved',
      resolved_at: '2026-09-26T09:00:00.000Z',
      item_id: ITEM,
      revision_id: 'rev_01J8Z3M4Q9V0X7K2B5N6P8R1T3',
    },
  ],
  narrative: null,
};

function event(sequence: number, over: Record<string, unknown> = {}) {
  return {
    id: `evt_${sequence}`,
    sequence,
    event_type: 'knowledge.updated',
    object_type: 'knowledge_item',
    object_id: ITEM,
    actor_id: AGENT_ACTOR,
    agent_id: 'ag_01J8Z3M4Q9V0X7K2B5N6P8R1T3',
    request_id: `req_${sequence}`,
    session_id: null,
    client: 'claude-code',
    provider: null,
    model: 'claude-opus-4',
    before_revision_id: null,
    before_content_hash: null,
    after_revision_id: 'rev_01J8Z3M4Q9V0X7K2B5N6P8R1T3',
    after_content_hash: null,
    proposal_id: null,
    category_paths: ['projects/pixel-brisbane'],
    metadata: {},
    created_at: '2026-09-26T09:00:00.000Z',
    ...over,
  };
}

/** Two pages of a descending feed, the newest first. */
const NEWEST = { events: [event(12), event(11)], next_sequence: 11, has_more: true };
const OLDER = { events: [event(10), event(9)], next_sequence: 9, has_more: false };

function workspace(permissions: string[]): Handler {
  return () =>
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
      permissions,
    });
}

const SIGNED_IN: Record<string, Handler> = {
  'GET /v1/auth/status': () => json({ bootstrap_required: false, authenticated: true }),
  'GET /v1/auth/me': () => json(ME),
  'GET /v1/auth/csrf': () => json({ token: 'csrf-token' }),
  'GET /v1/actors.list': () => json(ACTORS),
  'GET /v1/workspace.get': workspace(['knowledge.read', 'events.read_own', 'events.read_all']),
};

/** The ledger as it answers by default: a digest and one page of the feed. */
const LEDGER: Record<string, Handler> = {
  ...SIGNED_IN,
  'POST /v1/activity_digest': () => json(DIGEST),
  'POST /v1/events_list': (body) =>
    json((body as { before_sequence?: number }).before_sequence === undefined ? NEWEST : OLDER),
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

beforeEach(() => {
  resetCsrfToken();
  window.localStorage.clear();
  setWorkspace(undefined);
});
afterEach(() => vi.unstubAllGlobals());

describe('fixtures match the contracts', () => {
  it('parses the canned digest and feed', () => {
    expect(() => ActivityDigestResponse.parse(DIGEST)).not.toThrow();
    expect(() => EventsListResponse.parse(NEWEST)).not.toThrow();
  });
});

describe('the ledger vocabulary', () => {
  it('names every event type in every locale', () => {
    // An unnamed type falls back to `knowledge.proposed_supersede` on screen,
    // which is the enum leaking into the product.
    for (const [locale, bundle] of Object.entries(resources)) {
      const labels = (bundle.common as { events: { types: Record<string, string> } }).events.types;
      expect(
        EventType.options.filter((type) => !labels[type]),
        `unnamed in ${locale}`,
      ).toEqual([]);
    }
  });

  it('puts every event type in exactly one group', () => {
    // A type in no group is one the filters hide without saying so; a type in
    // two is one a reader meets twice.
    const homes = new Map(EventType.options.map((type) => [type, [] as string[]]));
    for (const group of GROUPS) {
      if (group === 'all') continue;
      for (const type of typesIn(group)) homes.get(type)!.push(group);
    }
    expect([...homes].filter(([, groups]) => groups.length !== 1)).toEqual([]);
  });
});

describe('the summary band', () => {
  it('counts the period and leads from each entry to the thing it touched', async () => {
    mockApi(LEDGER);
    renderApp('/ledger');

    const summary = await screen.findByRole('region', { name: 'Summary' });
    const counts = await within(summary).findByRole('list', { name: 'What happened' });
    expect(within(counts).getByText('Item changed')).toBeInTheDocument();
    expect(within(counts).getByText('4')).toBeInTheDocument();

    // A digest that names a decision and stops there leaves a reader holding
    // an id with nowhere to type it.
    expect(within(summary).getByRole('link', { name: 'Authentication strategy' })).toHaveAttribute(
      'href',
      `/knowledge?item=${ITEM}`,
    );
    expect(within(summary).getByRole('link', { name: ITEM })).toHaveAttribute(
      'href',
      `/review?proposal=${PROPOSAL}`,
    );
  });

  it('asks about the period the reader chose, and leaves the feed alone', async () => {
    const asked = mockApi(LEDGER);
    renderApp('/ledger');
    await screen.findByRole('region', { name: 'Summary' });
    const feeds = () => asked.filter((call) => call.url === '/v1/events_list').length;
    const before = feeds();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '30 days' }));

    const digests = await vi.waitFor(() => {
      const calls = asked.filter((call) => call.url === '/v1/activity_digest');
      expect(calls).toHaveLength(2);
      return calls;
    });
    const span = (call: { body: unknown }) =>
      Date.now() - new Date((call.body as { since: string }).since).getTime();
    // A month rather than the week it opened with.
    expect(span(digests[1]!)).toBeGreaterThan(span(digests[0]!) * 3);
    // The period selector sits inside the summary because it bounds only the
    // summary. A feed that refetched here would make that a lie.
    expect(feeds()).toBe(before);
    expect(screen.getByRole('button', { name: '30 days' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('offers the prose as an extra, and says so when no model can write it', async () => {
    mockApi({
      ...LEDGER,
      'POST /v1/activity_digest': (body) =>
        json(
          (body as { include_narrative?: boolean }).include_narrative
            ? { ...DIGEST, narrative: null }
            : DIGEST,
        ),
    });
    renderApp('/ledger');
    const user = userEvent.setup();
    // Counts first: rule 9 means the digest is an answer with no provider at
    // all, so the prose is a button and never an assumption.
    await user.click(await screen.findByRole('button', { name: 'Describe this period' }));

    expect(
      await screen.findByText(
        'No model is configured, so there is nothing to write the description. The counts are the summary.',
      ),
    ).toBeInTheDocument();
  });

  it('shows the prose and which model wrote it', async () => {
    mockApi({
      ...LEDGER,
      'POST /v1/activity_digest': (body) =>
        json(
          (body as { include_narrative?: boolean }).include_narrative
            ? { ...DIGEST, narrative: { text: 'A quiet week of edits.', model: 'llama3.1' } }
            : DIGEST,
        ),
    });
    renderApp('/ledger');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Describe this period' }));

    expect(await screen.findByText('A quiet week of edits.')).toBeInTheDocument();
    // Whose words they are, so a reader knows what they are reading.
    expect(screen.getByText('Written by llama3.1 from the counts above.')).toBeInTheDocument();
  });
});

describe('the feed', () => {
  it('says what happened, who did it and where it leads', async () => {
    mockApi(LEDGER);
    renderApp('/ledger');

    const feed = await screen.findByRole('region', { name: 'Every event' });
    const rows = await within(feed).findAllByRole('listitem');
    expect(rows).toHaveLength(2);
    // An actor id on screen is a name somebody has to go and look up.
    expect(within(rows[0]!).getByText('Claude Code')).toBeInTheDocument();
    expect(within(rows[0]!).getByRole('link', { name: ITEM })).toHaveAttribute(
      'href',
      `/knowledge?item=${ITEM}`,
    );
    // The position in the chain, which is what makes it a ledger.
    expect(within(rows[0]!).getByText('#12')).toBeInTheDocument();
  });

  it('pages backwards, because it is read newest first', async () => {
    const asked = mockApi(LEDGER);
    renderApp('/ledger');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Show more' }));

    expect(await screen.findByText('#9')).toBeInTheDocument();
    const feeds = asked.filter((call) => call.url === '/v1/events_list');
    expect(feeds).toHaveLength(2);
    expect(feeds[0]!.body).toMatchObject({ newest_first: true });
    expect(feeds[0]!.body).not.toHaveProperty('before_sequence');
    // The oldest sequence of the page before. `after_sequence` bounds the
    // other end and would hand back the newest page for ever.
    expect(feeds[1]!.body).toMatchObject({ before_sequence: 11 });
    // The page that said it had nothing older stops offering more.
    expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument();
  });

  it('asks the server for the group, not the browser for a slice of it', async () => {
    const asked = mockApi(LEDGER);
    renderApp('/ledger?group=knowledge');
    await screen.findByRole('region', { name: 'Every event' });

    const feeds = asked.filter((call) => call.url === '/v1/events_list');
    const types = (feeds[0]!.body as { event_types: string[] }).event_types;
    expect(types).toContain('knowledge.updated');
    // What a reader means by "knowledge" is what was recorded, not what was
    // asked for: a proposal belongs with the proposals.
    expect(types).not.toContain('knowledge.proposed_update');
    expect(types.length).toBeLessThan(EventType.options.length);
  });

  it('says so when the workspace has no history yet', async () => {
    mockApi({
      ...LEDGER,
      'POST /v1/events_list': () => json({ events: [], next_sequence: 0, has_more: false }),
      'POST /v1/activity_digest': () =>
        json({ ...DIGEST, counts: [], changed_items: [], resolved_proposals: [] }),
    });
    renderApp('/ledger');

    expect(
      await screen.findByText('Nothing has happened in this workspace yet.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Nothing happened in this period.')).toBeInTheDocument();
  });
});

describe('what the reader is allowed to see', () => {
  it('says the ledger is narrowed to them when it is', async () => {
    mockApi({
      ...LEDGER,
      'GET /v1/workspace.get': workspace(['knowledge.read', 'events.read_own']),
    });
    renderApp('/ledger');

    // Without `events.read_all` both bands answer with this actor's events, and
    // a quiet ledger is indistinguishable from a narrowed one.
    expect(
      await screen.findByText(
        'You are seeing your own events. Seeing everything that happened needs a wider permission.',
      ),
    ).toBeInTheDocument();
  });

  it('says nothing to a reader who sees the whole workspace', async () => {
    mockApi(LEDGER);
    renderApp('/ledger');
    await screen.findByRole('region', { name: 'Every event' });

    expect(screen.queryByText(/seeing your own events/)).not.toBeInTheDocument();
  });
});
