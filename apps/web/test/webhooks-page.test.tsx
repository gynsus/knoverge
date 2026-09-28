import { WebhooksResponse } from '@knoverge/contracts';
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
const WEBHOOK_ID = 'hook_01J8Z3M4Q9V0X7K2B5N6P8R1T3';

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
      permissions: ['workspace.admin', 'knowledge.read'],
    }),
  'GET /v1/actors.list': () => json({ actors: [] }),
};

const ENDPOINT = {
  id: WEBHOOK_ID,
  workspace_id: WORKSPACE_ID,
  url: 'https://example.com/knoverge',
  event_types: [] as string[],
  status: 'active' as const,
  cursor: 42,
  failures: 0,
  last_delivery_at: '2026-09-27T09:00:00.000Z',
  next_attempt_at: null,
  last_error: null,
  created_at: '2026-09-20T00:00:00.000Z',
  updated_at: '2026-09-27T09:00:00.000Z',
};

const NONE = { webhooks: [], secret_storage_configured: true };
const ONE = { webhooks: [ENDPOINT], secret_storage_configured: true };

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

describe('fixtures match the contract', () => {
  it('parses what the server answers', () => {
    expect(() => WebhooksResponse.parse(NONE)).not.toThrow();
    expect(() => WebhooksResponse.parse(ONE)).not.toThrow();
  });
});

beforeEach(() => {
  resetCsrfToken();
  window.localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe('an installation that cannot keep a secret', () => {
  it('says so before the form rather than after the save', async () => {
    mockApi({
      ...SIGNED_IN,
      'GET /v1/admin/webhooks.list': () => json({ webhooks: [], secret_storage_configured: false }),
    });
    renderApp('/settings/webhooks');

    // The variable is named, because "contact your administrator" is not an
    // instruction when the reader is the administrator.
    expect(await screen.findByText('KNOVERGE_ENCRYPTION_KEY')).toBeInTheDocument();
    expect(screen.getByText(/cannot keep a signing secret/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add an endpoint/i })).toBeDisabled();
  });
});

describe('adding an endpoint', () => {
  it('sends what was filled in, and shows the secret once', async () => {
    let listed: unknown = NONE;
    const calls = mockApi({
      ...SIGNED_IN,
      'GET /v1/admin/webhooks.list': () => json(listed),
      'POST /v1/admin/webhooks.upsert': () => {
        listed = ONE;
        return json({ webhook: ENDPOINT, secret: 'whsec_the_only_copy_there_will_ever_be' });
      },
    });
    const user = userEvent.setup();
    renderApp('/settings/webhooks');

    await user.click(await screen.findByRole('button', { name: /add an endpoint/i }));
    const form = await screen.findByRole('dialog');
    await user.type(within(form).getByLabelText('Address'), 'https://example.com/knoverge');
    await user.click(within(form).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith('/v1/admin/webhooks.upsert'))).toBe(true),
    );
    const sent = calls.find((c) => c.url.endsWith('/v1/admin/webhooks.upsert'))!.body as Record<
      string,
      unknown
    >;
    expect(sent['url']).toBe('https://example.com/knoverge');
    // Empty means every type, including ones a later version adds. Sending the
    // whole list instead would quietly stop delivering those.
    expect(sent['event_types']).toEqual([]);
    expect(sent['status']).toBe('active');
    // Nothing was typed, so nothing is claimed: the server generates it.
    expect(sent).not.toHaveProperty('secret');

    const shown = await screen.findByText('whsec_the_only_copy_there_will_ever_be');
    expect(shown).toBeInTheDocument();
    const secretDialog = await screen.findByRole('dialog');
    // The one moment it exists, so the way out waits until somebody says they
    // have it — and the check a receiver needs is on screen, not in a manual.
    expect(within(secretDialog).getByRole('button', { name: 'Close' })).toBeDisabled();
    expect(within(secretDialog).getByText(/x-knoverge-timestamp/)).toBeInTheDocument();
    await user.click(within(secretDialog).getByRole('checkbox'));
    expect(within(secretDialog).getByRole('button', { name: 'Close' })).toBeEnabled();
  });

  it('sends only the types that were chosen', async () => {
    const calls = mockApi({
      ...SIGNED_IN,
      'GET /v1/admin/webhooks.list': () => json(NONE),
      'POST /v1/admin/webhooks.upsert': () => json({ webhook: ENDPOINT, secret: null }),
    });
    const user = userEvent.setup();
    renderApp('/settings/webhooks?new');

    const form = await screen.findByRole('dialog');
    await user.type(within(form).getByLabelText('Address'), 'https://example.com/hook');
    await user.selectOptions(within(form).getByLabelText('What to send'), 'some');
    await user.click(await within(form).findByRole('checkbox', { name: 'Item created' }));
    await user.click(within(form).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith('/v1/admin/webhooks.upsert'))).toBe(true),
    );
    const sent = calls.find((c) => c.url.endsWith('/v1/admin/webhooks.upsert'))!.body as Record<
      string,
      unknown
    >;
    expect(sent['event_types']).toEqual(['knowledge.created']);
  });

  it('asks for everything by sending nothing, even after types were ticked', async () => {
    const calls = mockApi({
      ...SIGNED_IN,
      'GET /v1/admin/webhooks.list': () => json(NONE),
      'POST /v1/admin/webhooks.upsert': () => json({ webhook: ENDPOINT, secret: null }),
    });
    const user = userEvent.setup();
    renderApp('/settings/webhooks?new');

    const form = await screen.findByRole('dialog');
    await user.type(within(form).getByLabelText('Address'), 'https://example.com/hook');
    await user.selectOptions(within(form).getByLabelText('What to send'), 'some');
    await user.click(await within(form).findByRole('checkbox', { name: 'Item created' }));
    // Changed their mind. What the form sends now has to be the empty list, not
    // the one type still ticked behind the choice: empty is what makes a type
    // added in a later version arrive without anybody editing this endpoint.
    await user.selectOptions(within(form).getByLabelText('What to send'), 'all');
    await user.click(within(form).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith('/v1/admin/webhooks.upsert'))).toBe(true),
    );
    const sent = calls.find((c) => c.url.endsWith('/v1/admin/webhooks.upsert'))!.body as Record<
      string,
      unknown
    >;
    expect(sent['event_types']).toEqual([]);
  });
});

describe('a form that cannot be saved yet', () => {
  it('says which answer is missing rather than only greying the button', async () => {
    mockApi({ ...SIGNED_IN, 'GET /v1/admin/webhooks.list': () => json(NONE) });
    const user = userEvent.setup();
    renderApp('/settings/webhooks?new');

    const form = await screen.findByRole('dialog');
    await user.type(within(form).getByLabelText('Address'), 'example.com/hook');
    expect(within(form).getByText(/starts with http:\/\/ or https:\/\//)).toBeInTheDocument();
    expect(within(form).getByRole('button', { name: 'Save' })).toBeDisabled();

    await user.clear(within(form).getByLabelText('Address'));
    await user.type(within(form).getByLabelText('Address'), 'https://example.com/hook');
    await user.selectOptions(within(form).getByLabelText('What to send'), 'some');
    // Nothing ticked is not a webhook that hears everything; it is a webhook
    // that hears nothing, and the form says so instead of going quiet.
    expect(within(form).getByText(/Choose at least one type/)).toBeInTheDocument();
    expect(within(form).getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('shows a group as partly chosen when it is', async () => {
    mockApi({ ...SIGNED_IN, 'GET /v1/admin/webhooks.list': () => json(NONE) });
    const user = userEvent.setup();
    renderApp('/settings/webhooks?new');

    const form = await screen.findByRole('dialog');
    await user.selectOptions(within(form).getByLabelText('What to send'), 'some');
    await user.click(await within(form).findByRole('checkbox', { name: 'Item created' }));
    // Drawn as unchecked, the group box would say the group is off while one of
    // its types is on.
    expect(within(form).getByRole('checkbox', { name: 'Knowledge' })).toHaveAttribute(
      'aria-checked',
      'mixed',
    );
  });
});

describe('replacing a signing secret', () => {
  it('will not let a save keep the old one silently', async () => {
    const calls = mockApi({
      ...SIGNED_IN,
      'GET /v1/admin/webhooks.list': () => json(ONE),
      // Null, as the server answers for a secret the caller brought.
      'POST /v1/admin/webhooks.upsert': () => json({ webhook: ENDPOINT, secret: null }),
    });
    const user = userEvent.setup();
    renderApp(`/settings/webhooks?webhook=${WEBHOOK_ID}`);

    const form = await screen.findByRole('dialog');
    await user.click(within(form).getByRole('checkbox', { name: /Replace the signing secret/ }));
    // An update with the box empty keeps the secret it has, so a form that
    // allowed it would promise a replacement and perform nothing.
    expect(within(form).getByText(/would keep the old secret/)).toBeInTheDocument();
    expect(within(form).getByRole('button', { name: 'Save' })).toBeDisabled();

    await user.click(within(form).getByRole('button', { name: 'Generate' }));
    await user.click(within(form).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith('/v1/admin/webhooks.upsert'))).toBe(true),
    );
    const sent = calls.find((c) => c.url.endsWith('/v1/admin/webhooks.upsert'))!.body as Record<
      string,
      unknown
    >;
    const secret = sent['secret'] as string;
    expect(secret.length).toBeGreaterThanOrEqual(32);
    // The receiver needs it, and the server does not answer with a secret it
    // did not make — so what is shown once is what this browser sent.
    const shown = await screen.findByRole('dialog');
    expect(within(shown).getByText(secret)).toBeInTheDocument();
  });
});

describe('an endpoint that already exists', () => {
  it('says how it is going, which is the reason this screen exists', async () => {
    mockApi({
      ...SIGNED_IN,
      'GET /v1/admin/webhooks.list': () =>
        json({
          webhooks: [
            {
              ...ENDPOINT,
              event_types: ['knowledge.created', 'proposal.approved'],
              failures: 3,
              next_attempt_at: new Date(Date.now() + 8 * 60_000).toISOString(),
              last_error: 'connect ECONNREFUSED 10.0.0.9:443',
            },
          ],
          secret_storage_configured: true,
        }),
    });
    renderApp('/settings/webhooks');

    // The count, the wait and the error were all in the answer from the first
    // day, and an endpoint that stopped working stopped working silently.
    expect(await screen.findByText('Failing')).toBeInTheDocument();
    expect(screen.getByText(/3 attempts failed in a row/i)).toBeInTheDocument();
    expect(screen.getByText(/Next attempt/i)).toBeInTheDocument();
    expect(screen.getByText(/connect ECONNREFUSED 10\.0\.0\.9:443/)).toBeInTheDocument();
    // Named types rather than a number nobody can act on.
    expect(screen.getByText(/Item created/)).toBeInTheDocument();
  });

  it('does not say "now" about an attempt that has not happened', async () => {
    mockApi({
      ...SIGNED_IN,
      'GET /v1/admin/webhooks.list': () =>
        json({
          webhooks: [
            {
              ...ENDPOINT,
              failures: 1,
              // Due a second ago. The sweep takes it when the sweep runs, and a
              // reader told "now" reloads and decides the product is stuck.
              next_attempt_at: new Date(Date.now() - 1000).toISOString(),
              last_error: 'fetch failed',
            },
          ],
          secret_storage_configured: true,
        }),
    });
    renderApp('/settings/webhooks');

    expect(await screen.findByText(/Due to be tried again/)).toBeInTheDocument();
    expect(screen.queryByText(/Next attempt now/)).not.toBeInTheDocument();
  });

  it('keeps the secret it has when something else is changed', async () => {
    const calls = mockApi({
      ...SIGNED_IN,
      'GET /v1/admin/webhooks.list': () => json(ONE),
      'POST /v1/admin/webhooks.upsert': () => json({ webhook: ENDPOINT, secret: null }),
    });
    const user = userEvent.setup();
    renderApp(`/settings/webhooks?webhook=${WEBHOOK_ID}`);

    const form = await screen.findByRole('dialog');
    const url = within(form).getByLabelText('Address');
    expect(url).toHaveValue('https://example.com/knoverge');
    await user.clear(url);
    await user.type(url, 'https://example.com/moved');
    await user.click(within(form).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith('/v1/admin/webhooks.upsert'))).toBe(true),
    );
    const sent = calls.find((c) => c.url.endsWith('/v1/admin/webhooks.upsert'))!.body as Record<
      string,
      unknown
    >;
    expect(sent['webhook_id']).toBe(WEBHOOK_ID);
    expect(sent['url']).toBe('https://example.com/moved');
    // Left out, so the endpoint keeps the secret it has: an operator changing a
    // URL should not have to handle the secret to do it.
    expect(sent).not.toHaveProperty('secret');
  });

  it('is removed only after the address has been read back', async () => {
    const calls = mockApi({
      ...SIGNED_IN,
      'GET /v1/admin/webhooks.list': () => json(ONE),
      'POST /v1/admin/webhooks.delete': () => json({ ok: true }),
    });
    const user = userEvent.setup();
    renderApp('/settings/webhooks');

    await user.click(await screen.findByRole('button', { name: 'Remove' }));
    const confirm = await screen.findByRole('dialog');
    // The address is in the dialog, and the consequence with it: the place in
    // the ledger goes too, so the same URL added again starts from now.
    expect(within(confirm).getByText('https://example.com/knoverge')).toBeInTheDocument();
    expect(within(confirm).getByText(/never told what it missed/i)).toBeInTheDocument();
    expect(calls.some((c) => c.url.endsWith('/v1/admin/webhooks.delete'))).toBe(false);

    await user.click(within(confirm).getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith('/v1/admin/webhooks.delete'))).toBe(true),
    );
  });
});
