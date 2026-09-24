import { AiSettingsResponse } from '@knoverge/contracts';
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
const PROVIDER_ID = 'aip_01J8Z3M4Q9V0X7K2B5N6P8R1T3';

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

const SIGNED_IN: Record<string, Handler> = {
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
      permissions: ['workspace.admin', 'knowledge.read', 'knowledge.search'],
    }),
  'GET /v1/actors.list': () => json({ actors: [] }),
};

/** What an Ollama holding one embedding model and one chat model answers. */
const CATALOGUE = {
  reachable: true,
  version: '0.32.13',
  error: null,
  models: [
    { name: 'bge-m3:latest', size: 594_000_000, capabilities: ['embedding'] },
    { name: 'gpt-oss:120b', size: 65_000_000_000, capabilities: ['completion', 'tools'] },
  ],
};

const EMPTY = { ai: { providers: [], assignments: [], embeddings_enabled: false } };

const CONNECTED = {
  ai: {
    providers: [
      {
        id: PROVIDER_ID,
        kind: 'ollama',
        name: 'The big machine',
        base_url: 'http://ollama:11434',
        origin: 'interface',
        created_at: '2026-09-24T00:00:00.000Z',
        updated_at: '2026-09-24T00:00:00.000Z',
        last_checked_at: '2026-09-24T00:00:00.000Z',
        last_error: null,
      },
    ],
    assignments: [
      {
        purpose: 'embedding',
        provider_id: PROVIDER_ID,
        model: 'bge-m3:latest',
        updated_at: '2026-09-24T00:00:00.000Z',
      },
    ],
    embeddings_enabled: true,
  },
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

describe('fixtures match the contracts', () => {
  it('parses both settings shapes', () => {
    expect(() => AiSettingsResponse.parse(EMPTY)).not.toThrow();
    expect(() => AiSettingsResponse.parse(CONNECTED)).not.toThrow();
  });
});

beforeEach(() => {
  resetCsrfToken();
  window.localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe('with nothing connected', () => {
  it('names what still works rather than showing an empty box', async () => {
    mockApi({ ...SIGNED_IN, 'GET /v1/admin/ai.settings': () => json(EMPTY) });
    renderApp('/settings/ai');
    // A self-hosted product whose settings imply an AI provider is mandatory
    // has told its operator something untrue about what they are running.
    expect(await screen.findByText(/Search, proposals, review, history/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /connect a provider/i })).toBeInTheDocument();
  });
});

describe('the connection wizard', () => {
  it('walks from an address to a working model, and saves only at the end', async () => {
    let settings: unknown = EMPTY;
    const calls = mockApi({
      ...SIGNED_IN,
      'GET /v1/admin/ai.settings': () => json(settings),
      'POST /v1/admin/ai.providers.check': () => json(CATALOGUE),
      'POST /v1/admin/ai.test': () =>
        json({ ok: true, dimensions: 1024, latency_ms: 41, error: null }),
      'POST /v1/admin/ai.providers.save': () => {
        settings = { ai: { ...CONNECTED.ai, assignments: [], embeddings_enabled: false } };
        return json(settings);
      },
      'POST /v1/admin/ai.assign': () => {
        settings = CONNECTED;
        return json(settings);
      },
    });
    const user = userEvent.setup();
    renderApp('/settings/ai');

    await user.click(await screen.findByRole('button', { name: /connect a provider/i }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/address/i), 'http://ollama:11434');
    await user.click(within(dialog).getByRole('button', { name: /check the connection/i }));

    expect(await within(dialog).findByText(/version 0\.32\.13/i)).toBeInTheDocument();
    // Nothing has been stored by asking what is there.
    expect(calls.some((c) => c.url.includes('providers.save'))).toBe(false);

    const models = within(dialog).getByLabelText(/embedding model/i);
    // A generative model chosen as an embedding model costs a rebuild and
    // answers nothing useful, so it is not offered.
    expect(within(models).queryByRole('option', { name: /gpt-oss/i })).toBeNull();
    await user.selectOptions(models, 'bge-m3:latest');

    await user.click(within(dialog).getByRole('button', { name: /test this model/i }));
    // The number the whole index hangs from, which nobody configures.
    expect(await within(dialog).findByText(/1024 numbers per vector/i)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: /save and use it/i }));

    await waitFor(() => expect(screen.getByText(/Embedding with bge-m3/i)).toBeInTheDocument());
    const saved = calls.find((c) => c.url.includes('providers.save'))?.body as { base_url: string };
    expect(saved.base_url).toBe('http://ollama:11434');
    expect(calls.find((c) => c.url.includes('ai.assign'))?.body).toMatchObject({
      purpose: 'embedding',
      model: 'bge-m3:latest',
    });
  });

  it('shows the provider its own words when nothing answers', async () => {
    mockApi({
      ...SIGNED_IN,
      'GET /v1/admin/ai.settings': () => json(EMPTY),
      'POST /v1/admin/ai.providers.check': () =>
        json({
          reachable: false,
          version: null,
          models: [],
          error: 'connect ECONNREFUSED 192.168.1.7:11434',
        }),
    });
    const user = userEvent.setup();
    renderApp('/settings/ai');
    await user.click(await screen.findByRole('button', { name: /connect a provider/i }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/address/i), 'http://192.168.1.7:11434');
    await user.click(within(dialog).getByRole('button', { name: /check the connection/i }));
    // The only thing that says whether this is the wrong port or the wrong
    // machine.
    expect(await within(dialog).findByText(/ECONNREFUSED/)).toBeInTheDocument();
  });
});

describe('a provider that is connected', () => {
  it('says where its configuration came from', async () => {
    // The question an operator asks first when the compose file and this page
    // disagree.
    mockApi({
      ...SIGNED_IN,
      'GET /v1/admin/ai.settings': () =>
        json({
          ai: {
            ...CONNECTED.ai,
            providers: [{ ...CONNECTED.ai.providers[0], origin: 'environment' }],
          },
        }),
    });
    renderApp('/settings/ai');
    expect(await screen.findByText(/from the environment/i)).toBeInTheDocument();
  });
});
