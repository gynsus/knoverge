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

/** The same machine, once somebody has pulled a second model that writes. */
const TWO_WRITERS = {
  ...CATALOGUE,
  models: [
    ...CATALOGUE.models,
    { name: 'qwen2.5vl:7b', size: 6_000_000_000, capabilities: ['completion', 'vision'] },
  ],
};

const EMPTY = {
  ai: {
    providers: [],
    assignments: [],
    embeddings_enabled: false,
    generation_enabled: false,
    vision_enabled: false,
    transcription_enabled: false,
    secret_storage_configured: true,
  },
};

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
        has_api_key: false,
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
    generation_enabled: false,
    vision_enabled: false,
    transcription_enabled: false,
    secret_storage_configured: true,
  },
};

/** The same installation, with a model writing as well as one measuring. */
const GENERATING = {
  ai: {
    ...CONNECTED.ai,
    assignments: [
      ...CONNECTED.ai.assignments,
      {
        purpose: 'generation',
        provider_id: PROVIDER_ID,
        model: 'gpt-oss:120b',
        updated_at: '2026-09-24T00:00:00.000Z',
      },
    ],
    generation_enabled: true,
    vision_enabled: false,
    transcription_enabled: false,
    secret_storage_configured: true,
  },
};

const WHISPER_ID = 'aip_01J8Z3M4Q9V0X7K2B5N6P8R1T4';

/** An installation whose provider speaks the shape that has a listening endpoint. */
const WHISPERING = {
  ai: {
    ...CONNECTED.ai,
    providers: [
      ...CONNECTED.ai.providers,
      {
        id: WHISPER_ID,
        kind: 'openai_compatible',
        name: 'The transcription box',
        base_url: 'http://whisper:8000',
        origin: 'interface',
        created_at: '2026-09-28T00:00:00.000Z',
        updated_at: '2026-09-28T00:00:00.000Z',
        last_checked_at: '2026-09-28T00:00:00.000Z',
        last_error: null,
        has_api_key: true,
      },
    ],
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
    expect(() => AiSettingsResponse.parse(GENERATING)).not.toThrow();
    expect(() => AiSettingsResponse.parse(WHISPERING)).not.toThrow();
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

  it('connects a server that is not Ollama, with the key that server wants', async () => {
    let settings: unknown = EMPTY;
    const calls = mockApi({
      ...SIGNED_IN,
      'GET /v1/admin/ai.settings': () => json(settings),
      'POST /v1/admin/ai.providers.check': () =>
        json({
          reachable: true,
          version: null,
          models: [{ name: 'whisper-1', capabilities: [] }],
          error: null,
        }),
      'POST /v1/admin/ai.providers.save': () => {
        settings = WHISPERING;
        return json(settings);
      },
      'POST /v1/admin/ai.assign': () => json(settings),
    });
    const user = userEvent.setup({ delay: null });
    renderApp('/settings/ai');

    await user.click(await screen.findByRole('button', { name: /connect a provider/i }));
    const dialog = await screen.findByRole('dialog');
    await user.selectOptions(within(dialog).getByLabelText(/kind/i), 'openai_compatible');

    // The suggested name follows the kind: a row called Ollama that is not one
    // is a row an operator will misread later.
    expect(within(dialog).getByLabelText(/^name/i)).toHaveValue('OpenAI-compatible');

    const key = within(dialog).getByLabelText(/API key/i);
    // A password field, so it is not read over a shoulder and a browser does
    // not offer to remember it as text.
    expect(key).toHaveAttribute('type', 'password');
    await user.type(key, 'sk-live-1234');

    await user.type(within(dialog).getByLabelText(/address/i), 'http://whisper:8000');
    await user.click(within(dialog).getByRole('button', { name: /check the connection/i }));
    // The probe carries it, because a form that can only test what is already
    // stored teaches people to store things that do not work.
    expect(calls.find((c) => c.url.includes('providers.check'))?.body).toMatchObject({
      api_key: 'sk-live-1234',
    });

    await user.selectOptions(await within(dialog).findByLabelText(/embedding model/i), 'whisper-1');
    await user.click(within(dialog).getByRole('button', { name: /save and use it/i }));

    await waitFor(() => expect(calls.some((c) => c.url.includes('providers.save'))).toBe(true));
    expect(calls.find((c) => c.url.includes('providers.save'))?.body).toMatchObject({
      kind: 'openai_compatible',
      base_url: 'http://whisper:8000',
      api_key: 'sk-live-1234',
    });
  });

  it('asks Ollama for no key, because Ollama wants none', async () => {
    mockApi({ ...SIGNED_IN, 'GET /v1/admin/ai.settings': () => json(EMPTY) });
    const user = userEvent.setup({ delay: null });
    renderApp('/settings/ai');

    await user.click(await screen.findByRole('button', { name: /connect a provider/i }));
    const dialog = await screen.findByRole('dialog');
    // A field that could only be left empty is a question nobody should be
    // asked.
    expect(within(dialog).queryByLabelText(/API key/i)).not.toBeInTheDocument();
  });

  it('does not offer to type a key where there is nowhere to keep one', async () => {
    mockApi({
      ...SIGNED_IN,
      'GET /v1/admin/ai.settings': () =>
        json({ ai: { ...EMPTY.ai, secret_storage_configured: false } }),
    });
    const user = userEvent.setup({ delay: null });
    renderApp('/settings/ai');

    await user.click(await screen.findByRole('button', { name: /connect a provider/i }));
    const dialog = await screen.findByRole('dialog');
    await user.selectOptions(within(dialog).getByLabelText(/kind/i), 'openai_compatible');
    // The installation's answer, not the caller's. A field that refuses is
    // worse than a line saying what to set.
    expect(within(dialog).queryByLabelText(/API key/i)).not.toBeInTheDocument();
    expect(within(dialog).getByText(/no KNOVERGE_ENCRYPTION_KEY/i)).toBeInTheDocument();
  });

  it('keeps a stored key through a change nobody retyped it in', async () => {
    const settings: unknown = WHISPERING;
    const calls = mockApi({
      ...SIGNED_IN,
      'GET /v1/admin/ai.settings': () => json(settings),
      'POST /v1/admin/ai.providers.check': () => json(CATALOGUE),
      'POST /v1/admin/ai.providers.save': () => json(settings),
      'POST /v1/admin/ai.assign': () => json(settings),
    });
    const user = userEvent.setup({ delay: null });
    renderApp('/settings/ai');

    await user.click(await screen.findByRole('button', { name: 'Choose a transcription model' }));
    const dialog = await screen.findByRole('dialog');
    // Whether, never which: the key is not put back in a field for somebody to
    // read off a screen.
    expect(within(dialog).queryByLabelText(/API key/i)).not.toBeInTheDocument();
    expect(within(dialog).getByText(/A key is kept for this provider/i)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: /check the connection/i }));
    await user.selectOptions(
      await within(dialog).findByLabelText(/transcription model/i),
      'gpt-oss:120b',
    );
    await user.click(within(dialog).getByRole('button', { name: /save and use it/i }));

    await waitFor(() => expect(calls.some((c) => c.url.includes('providers.save'))).toBe(true));
    const sent = calls.find((c) => c.url.includes('providers.save'))?.body;
    // No `api_key` at all, which is what keeps it: sending null would clear it.
    expect(sent).not.toHaveProperty('api_key');
  });

  it('clears a key when somebody replaces it with nothing', async () => {
    const settings: unknown = WHISPERING;
    const calls = mockApi({
      ...SIGNED_IN,
      'GET /v1/admin/ai.settings': () => json(settings),
      'POST /v1/admin/ai.providers.check': () => json(CATALOGUE),
      'POST /v1/admin/ai.providers.save': () => json(settings),
      'POST /v1/admin/ai.assign': () => json(settings),
    });
    const user = userEvent.setup({ delay: null });
    renderApp('/settings/ai');

    await user.click(await screen.findByRole('button', { name: 'Choose a transcription model' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /Replace the key/i }));
    // Left empty on purpose: a provider that stopped needing a key has to be
    // able to say so.
    expect(within(dialog).getByLabelText(/API key/i)).toHaveValue('');

    await user.click(within(dialog).getByRole('button', { name: /check the connection/i }));
    await user.selectOptions(
      await within(dialog).findByLabelText(/transcription model/i),
      'gpt-oss:120b',
    );
    await user.click(within(dialog).getByRole('button', { name: /save and use it/i }));

    await waitFor(() => expect(calls.some((c) => c.url.includes('providers.save'))).toBe(true));
    expect(calls.find((c) => c.url.includes('providers.save'))?.body).toMatchObject({
      api_key: null,
    });
  });

  it('names each step once, and keeps the name for a screen reader', async () => {
    // The step indicator shows the labels from `sm` up, so a legend saying the
    // same words is the same words twice. It stays in the accessibility tree
    // at every width: a fieldset named only on a phone has no name on a laptop.
    mockApi({ ...SIGNED_IN, 'GET /v1/admin/ai.settings': () => json(EMPTY) });
    const user = userEvent.setup();
    renderApp('/settings/ai');
    await user.click(await screen.findByRole('button', { name: /connect a provider/i }));
    const dialog = await screen.findByRole('dialog');
    const legend = within(dialog).getByText('Where it is', { selector: 'legend' });
    expect(legend.className).toContain('sm:sr-only');
    // A legend takes no part in the grid gap, so its spacing has to be its
    // own, and it reads as a heading rather than as another field label.
    expect(legend.className).toContain('mb-3');
    expect(legend.className).toContain('font-semibold');
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

describe('choosing a model that writes', () => {
  it('has nothing to press until a provider exists', async () => {
    // A control that could only fail is worse than one that says why it is off.
    mockApi({ ...SIGNED_IN, 'GET /v1/admin/ai.settings': () => json(EMPTY) });
    renderApp('/settings/ai');
    // Every purpose that needs a model of its own: writing, reading pictures
    // and listening to recordings.
    const choose = await screen.findAllByRole('button', {
      name: /choose a (model|vision model|transcription model)/i,
    });
    expect(choose).toHaveLength(3);
    for (const button of choose) expect(button).toBeDisabled();
    expect(screen.getAllByText(/connect a provider above first/i).length).toBeGreaterThan(0);
  });

  it('tests a model by reading what it wrote, and assigns it to generation', async () => {
    let settings: unknown = CONNECTED;
    const calls = mockApi({
      ...SIGNED_IN,
      'GET /v1/admin/ai.settings': () => json(settings),
      'POST /v1/admin/ai.providers.check': () => json(CATALOGUE),
      'POST /v1/admin/ai.providers.save': () => json(settings),
      'POST /v1/admin/ai.test_generation': () =>
        json({ ok: true, text: 'The ledger only grows.', latency_ms: 812, error: null }),
      'POST /v1/admin/ai.assign': () => {
        settings = GENERATING;
        return json(settings);
      },
    });
    const user = userEvent.setup();
    renderApp('/settings/ai');

    await user.click(await screen.findByRole('button', { name: 'Choose a model' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /check the connection/i }));

    const models = await within(dialog).findByLabelText(/generation model/i);
    // An embedding model asked to write answers nothing, so it is not offered.
    expect(within(models).queryByRole('option', { name: /bge-m3/i })).toBeNull();
    await user.selectOptions(models, 'gpt-oss:120b');

    await user.click(within(dialog).getByRole('button', { name: /test this model/i }));
    // What it said, not a tick: a model that answers quickly and says nothing
    // useful is one to see before assigning.
    expect(await within(dialog).findByText(/The ledger only grows/)).toBeInTheDocument();
    // The embedding test is not the one that ran.
    expect(calls.some((c) => c.url.endsWith('/v1/admin/ai.test'))).toBe(false);

    await user.click(within(dialog).getByRole('button', { name: /save and use it/i }));
    await waitFor(() => expect(screen.getByText(/Writing with gpt-oss/i)).toBeInTheDocument());
    expect(calls.find((c) => c.url.includes('ai.assign'))?.body).toMatchObject({
      purpose: 'generation',
      model: 'gpt-oss:120b',
    });
  });

  it('chooses a model that sees by showing it a picture', async () => {
    let settings: unknown = CONNECTED;
    const calls = mockApi({
      ...SIGNED_IN,
      'GET /v1/admin/ai.settings': () => json(settings),
      'POST /v1/admin/ai.providers.check': () => json(CATALOGUE),
      'POST /v1/admin/ai.providers.save': () => json(settings),
      'POST /v1/admin/ai.test_vision': () =>
        json({ ok: true, text: 'Red.', latency_ms: 1502, error: null }),
      'POST /v1/admin/ai.assign': () => {
        settings = {
          ai: {
            ...CONNECTED.ai,
            assignments: [
              ...CONNECTED.ai.assignments,
              {
                purpose: 'vision',
                provider_id: PROVIDER_ID,
                model: 'gpt-oss:120b',
                updated_at: '2026-09-28T00:00:00.000Z',
              },
            ],
            vision_enabled: true,
            transcription_enabled: false,
            secret_storage_configured: true,
          },
        };
        return json(settings);
      },
    });
    const user = userEvent.setup({ delay: null });
    renderApp('/settings/ai');

    await user.click(await screen.findByRole('button', { name: 'Choose a vision model' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /check the connection/i }));
    await user.selectOptions(
      await within(dialog).findByLabelText(/generation model/i),
      'gpt-oss:120b',
    );
    await user.click(within(dialog).getByRole('button', { name: /test this model/i }));

    // A catalogue lists names and sometimes capabilities, and neither says which
    // models can see. The test sends a picture of a red square and shows what
    // came back, so the operator judges rather than a tick.
    expect(await within(dialog).findByText(/Red\./)).toBeInTheDocument();
    expect(calls.some((c) => c.url.endsWith('/v1/admin/ai.test_vision'))).toBe(true);
    expect(calls.some((c) => c.url.endsWith('/v1/admin/ai.test_generation'))).toBe(false);

    await user.click(within(dialog).getByRole('button', { name: /save and use it/i }));
    await waitFor(() =>
      expect(screen.getByText(/Reading pictures with gpt-oss/i)).toBeInTheDocument(),
    );
    expect(calls.find((c) => c.url.includes('ai.assign'))?.body).toMatchObject({
      purpose: 'vision',
      model: 'gpt-oss:120b',
    });
  });

  it('says why a recording cannot be listened to, rather than offering a model that cannot', async () => {
    // A provider exists and works. It simply has no endpoint that takes a
    // recording, and the page says which shape does instead of offering a
    // choice that could only fail.
    mockApi({ ...SIGNED_IN, 'GET /v1/admin/ai.settings': () => json(CONNECTED) });
    renderApp('/settings/ai');

    expect(
      await screen.findByRole('button', { name: 'Choose a transcription model' }),
    ).toBeDisabled();
    expect(screen.getByText(/needs an OpenAI-compatible provider/i)).toBeInTheDocument();
    // The other two are offered from the same provider, which is what makes
    // this one being off a statement about the provider and not about the page.
    expect(screen.getByRole('button', { name: 'Choose a vision model' })).toBeEnabled();
  });

  it('chooses a model that listens, and says outright that it cannot be tested first', async () => {
    let settings: unknown = WHISPERING;
    const calls = mockApi({
      ...SIGNED_IN,
      'GET /v1/admin/ai.settings': () => json(settings),
      'POST /v1/admin/ai.providers.check': () => json(CATALOGUE),
      'POST /v1/admin/ai.providers.save': () => json(settings),
      'POST /v1/admin/ai.assign': () => {
        settings = {
          ai: {
            ...WHISPERING.ai,
            assignments: [
              ...WHISPERING.ai.assignments,
              {
                purpose: 'transcription',
                provider_id: WHISPER_ID,
                model: 'whisper-1',
                updated_at: '2026-09-28T00:00:00.000Z',
              },
            ],
            transcription_enabled: true,
            secret_storage_configured: true,
          },
        };
        return json(settings);
      },
    });
    const user = userEvent.setup({ delay: null });
    renderApp('/settings/ai');

    await user.click(await screen.findByRole('button', { name: 'Choose a transcription model' }));
    const dialog = await screen.findByRole('dialog');
    // The one provider that could do this is where the wizard starts.
    expect(within(dialog).getByLabelText(/address/i)).toHaveValue('http://whisper:8000');
    await user.click(within(dialog).getByRole('button', { name: /check the connection/i }));

    const models = await within(dialog).findByLabelText(/transcription model/i);
    // Nothing is filtered out: no catalogue has a word for a model that
    // listens, and a filter built on the two words that exist would hide every
    // model that can do it.
    expect(within(models).getByRole('option', { name: /bge-m3/i })).toBeInTheDocument();
    expect(within(models).getByRole('option', { name: /gpt-oss/i })).toBeInTheDocument();

    // And no probe. Speech is the one thing that cannot be made up here, so the
    // wizard says what the test is instead of pretending to have run one.
    expect(within(dialog).queryByRole('button', { name: /test this model/i })).toBeNull();
    expect(within(dialog).getByText(/no test for this one/i)).toBeInTheDocument();

    await user.selectOptions(models, 'gpt-oss:120b');
    await user.click(within(dialog).getByRole('button', { name: /save and use it/i }));
    await waitFor(() => expect(screen.getByText(/Listening with whisper-1/i)).toBeInTheDocument());
    expect(calls.find((c) => c.url.includes('ai.assign'))?.body).toMatchObject({
      purpose: 'transcription',
      provider_id: WHISPER_ID,
      model: 'gpt-oss:120b',
    });
  });

  it('reopens a purpose on the model that purpose is using, not on another one', async () => {
    const SEEING = {
      ai: {
        ...CONNECTED.ai,
        assignments: [
          ...CONNECTED.ai.assignments,
          {
            purpose: 'vision',
            provider_id: PROVIDER_ID,
            model: 'qwen2.5vl:7b',
            updated_at: '2026-09-28T00:00:00.000Z',
          },
        ],
        vision_enabled: true,
        secret_storage_configured: true,
      },
    };
    mockApi({
      ...SIGNED_IN,
      'GET /v1/admin/ai.settings': () => json(SEEING),
      'POST /v1/admin/ai.providers.check': () => json(TWO_WRITERS),
    });
    const user = userEvent.setup({ delay: null });
    renderApp('/settings/ai');

    // The row for this purpose, not the provider's own Change above it.
    const row = await screen.findByRole('region', { name: /reading pictures/i });
    await user.click(await within(row).findByRole('button', { name: /change/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /check the connection/i }));

    // The model this purpose is already using, and not the one embedding uses:
    // pressing Change on a row opens on what that row says.
    expect(await within(dialog).findByLabelText(/generation model/i)).toHaveValue('qwen2.5vl:7b');
  });

  it('stops using it without touching what measures', async () => {
    let settings: unknown = GENERATING;
    const calls = mockApi({
      ...SIGNED_IN,
      'GET /v1/admin/ai.settings': () => json(settings),
      'POST /v1/admin/ai.unassign': () => {
        settings = CONNECTED;
        return json(settings);
      },
    });
    const user = userEvent.setup();
    renderApp('/settings/ai');

    await user.click(await screen.findByRole('button', { name: /stop using it/i }));
    await waitFor(() =>
      expect(screen.getByText(/No model is writing anything/i)).toBeInTheDocument(),
    );
    expect(calls.find((c) => c.url.includes('ai.unassign'))?.body).toEqual({
      purpose: 'generation',
    });
    // The embedding model is still at work: two purposes, two assignments.
    expect(screen.getByText(/Embedding with bge-m3/i)).toBeInTheDocument();
  });
});
