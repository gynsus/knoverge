import { BackupSettingsResponse, BackupsResponse } from '@knoverge/contracts';
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

/** The row the migration creates: an installation that has configured nothing. */
const OFF = {
  enabled: false,
  interval_hours: 24,
  retention_days: 14,
  target: null,
  target_secret_set: false,
  secret_storage_configured: true,
  target_host_fingerprint: null,
  last_run_at: null,
  last_error: null,
  last_upload_at: null,
  last_upload_error: null,
};

const TARGET = {
  host: 'copies.example',
  port: 2222,
  username: 'knoverge',
  directory: '/srv/copies',
  auth_kind: 'private_key' as const,
};

/** Configured, connected once, and the key it met pinned. */
const PINNED = {
  ...OFF,
  enabled: true,
  interval_hours: 12,
  retention_days: 7,
  target: TARGET,
  target_secret_set: true,
  target_host_fingerprint: 'SHA256:zTt+Yq1pQ',
  last_run_at: '2026-10-10T08:00:00.000Z',
  last_upload_at: '2026-10-10T08:00:05.000Z',
};

const COPY = {
  name: '20261010T080000Z',
  taken_at: '2026-10-10T08:00:00.000Z',
  size_bytes: 3_145_728,
  uploaded: true as boolean | null,
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

/**
 * Every query answered.
 *
 * What a person may do arrives in its own request, so a control that depends on
 * it is absent for a moment on every render. Asserting absence without waiting
 * would pass whether the rule works or not.
 */
async function settled(client: QueryClient): Promise<void> {
  await waitFor(() => expect(client.isFetching()).toBe(0));
}

describe('fixtures match the contract', () => {
  it('parses what the server answers', () => {
    expect(() => BackupSettingsResponse.parse({ settings: OFF })).not.toThrow();
    expect(() => BackupSettingsResponse.parse({ settings: PINNED })).not.toThrow();
    expect(() => BackupsResponse.parse({ backups: [COPY] })).not.toThrow();
  });
});

beforeEach(() => {
  resetCsrfToken();
  window.localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe('an installation that cannot keep a credential', () => {
  it('says so above the control rather than refusing the save', async () => {
    mockApi({
      ...signedIn(),
      'GET /v1/admin/backups.settings': () =>
        json({ settings: { ...OFF, secret_storage_configured: false } }),
      'GET /v1/admin/backups.list': () => json({ backups: [] }),
    });
    renderApp('/settings/storage');

    // Named, because "contact your administrator" is not an instruction when
    // the reader is the administrator.
    expect(await screen.findByText('KNOVERGE_ENCRYPTION_KEY')).toBeInTheDocument();
    expect(
      screen.getByRole('checkbox', { name: /send each copy to another machine/i }),
    ).toBeDisabled();
    // And the schedule is still offered: a copy on this machine needs no key.
    expect(screen.getByRole('checkbox', { name: /take copies on a schedule/i })).toBeEnabled();
  });
});

describe('an installation that has configured nothing', () => {
  it('leads with what leaves, and has no copies to show', async () => {
    mockApi({
      ...signedIn(),
      'GET /v1/admin/backups.settings': () => json({ settings: OFF }),
      'GET /v1/admin/backups.list': () => json({ backups: [] }),
    });
    renderApp('/settings/storage');

    // Rule 2o: the decision is about what the second machine then holds, and
    // that is said before the address field, not in the documentation.
    expect(await screen.findByText(/every workspace repository/i)).toBeInTheDocument();
    expect(await screen.findByText(/none yet/i)).toBeInTheDocument();
    expect(screen.getByText(/no copy has been taken yet/i)).toBeInTheDocument();
    // Nothing is pinned because nothing has connected, and with no target there
    // is nothing to say about a host key at all.
    expect(screen.queryByRole('heading', { name: /host key/i })).not.toBeInTheDocument();
  });

  it('sends the whole setting, with no target, when the schedule is turned on', async () => {
    const calls = mockApi({
      ...signedIn(),
      'GET /v1/admin/backups.settings': () => json({ settings: OFF }),
      'GET /v1/admin/backups.list': () => json({ backups: [] }),
      'POST /v1/admin/backups.save': () => json({ settings: { ...OFF, enabled: true } }),
    });
    renderApp('/settings/storage');
    const user = userEvent.setup();

    await user.click(await screen.findByRole('checkbox', { name: /take copies on a schedule/i }));
    await user.clear(screen.getByLabelText(/how often, in hours/i));
    await user.type(screen.getByLabelText(/how often, in hours/i), '6');
    await user.click(await screen.findByRole('button', { name: /^save$/i }));

    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith('backups.save'))?.body).toEqual({
        enabled: true,
        interval_hours: 6,
        retention_days: 14,
        // The whole setting at once, which is the shape of the call: a
        // half-applied change to a schedule and a target is a copy going
        // somewhere nobody meant.
        target: null,
      }),
    );
  });
});

describe('naming the second machine', () => {
  it('sends the address with the credential, once', async () => {
    const calls = mockApi({
      ...signedIn(),
      'GET /v1/admin/backups.settings': () => json({ settings: { ...OFF, enabled: true } }),
      'GET /v1/admin/backups.list': () => json({ backups: [] }),
      'POST /v1/admin/backups.save': () => json({ settings: PINNED }),
    });
    renderApp('/settings/storage');
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole('checkbox', { name: /send each copy to another machine/i }),
    );
    await user.type(screen.getByLabelText(/^host$/i), 'copies.example');
    await user.clear(screen.getByLabelText(/^port$/i));
    await user.type(screen.getByLabelText(/^port$/i), '2222');
    await user.type(screen.getByLabelText(/^user$/i), 'knoverge');
    await user.type(screen.getByLabelText(/^directory$/i), '/srv/copies');
    await user.type(screen.getByLabelText(/^private key$/i), 'the key');
    await user.click(await screen.findByRole('button', { name: /^save$/i }));

    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith('backups.save'))?.body).toEqual({
        enabled: true,
        interval_hours: 24,
        retention_days: 14,
        target: TARGET,
        target_secret: 'the key',
      }),
    );
    // And the field is emptied, because what comes back says whether one is
    // stored and never which (ADR 0033).
    await waitFor(() => expect(screen.getByLabelText(/^private key$/i)).toHaveValue(''));
  });

  it('changes the address without asking for the key again', async () => {
    const calls = mockApi({
      ...signedIn(),
      'GET /v1/admin/backups.settings': () => json({ settings: PINNED }),
      'GET /v1/admin/backups.list': () => json({ backups: [] }),
      'POST /v1/admin/backups.save': () => json({ settings: PINNED }),
    });
    renderApp('/settings/storage');
    const user = userEvent.setup();

    expect(await screen.findByText(/one is stored/i)).toBeInTheDocument();
    await user.clear(screen.getByLabelText(/^port$/i));
    await user.type(screen.getByLabelText(/^port$/i), '22');
    await user.click(await screen.findByRole('button', { name: /^save$/i }));

    // No `target_secret` at all. An operator changing a port should not have to
    // find a private key, and a form that sent an empty one would clear it
    // (WEB_UI.md rule 2m).
    await waitFor(() => {
      const body = calls.find((c) => c.url.endsWith('backups.save'))?.body as Record<
        string,
        unknown
      >;
      expect(body).not.toHaveProperty('target_secret');
      expect(body['target']).toEqual({ ...TARGET, port: 22 });
    });
  });

  it('says a new credential is needed when the kind changes', async () => {
    mockApi({
      ...signedIn(),
      'GET /v1/admin/backups.settings': () => json({ settings: PINNED }),
      'GET /v1/admin/backups.list': () => json({ backups: [] }),
    });
    renderApp('/settings/storage');
    const user = userEvent.setup();

    expect(await screen.findByText(/one is stored/i)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText(/authenticate with/i), 'password');

    // A key is not a password: the server refuses to keep one while the form
    // asks for the other, and that is said here rather than after the save.
    expect(screen.getByText(/typed once and never shown again/i)).toBeInTheDocument();
    expect(screen.queryByText(/one is stored/i)).not.toBeInTheDocument();
  });
});

describe('the key this installation pinned', () => {
  it('shows it with the command to compare it against', async () => {
    mockApi({
      ...signedIn(),
      'GET /v1/admin/backups.settings': () => json({ settings: PINNED }),
      'GET /v1/admin/backups.list': () => json({ backups: [] }),
    });
    renderApp('/settings/storage');

    expect(await screen.findByText('SHA256:zTt+Yq1pQ')).toBeInTheDocument();
    // Built from the address that was saved, ports included: a command an
    // operator has to edit before running is a command they will mistype.
    expect(
      screen.getByText('ssh-keyscan -p 2222 copies.example | ssh-keygen -lf -'),
    ).toBeInTheDocument();
  });

  it('states the consequence before it is forgotten', async () => {
    const calls = mockApi({
      ...signedIn(),
      'GET /v1/admin/backups.settings': () => json({ settings: PINNED }),
      'GET /v1/admin/backups.list': () => json({ backups: [] }),
      'POST /v1/admin/backups.clear_host_key': () =>
        json({ settings: { ...PINNED, target_host_fingerprint: null } }),
    });
    renderApp('/settings/storage');
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: /forget this key/i }));

    const dialog = screen.getByRole('dialog');
    // The consequence, and the one mistake worth warning about: a failed upload
    // looks exactly like somebody else answering (WEB_UI.md rule 4).
    expect(within(dialog).getByText(/accept whatever answers/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/not because an upload failed/i)).toBeInTheDocument();
    expect(within(dialog).getByText('SHA256:zTt+Yq1pQ')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: /forget this key/i }));

    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith('backups.clear_host_key'))).toBe(true),
    );
  });
});

describe('how the copies are going', () => {
  it('separates a copy that was taken from one that arrived', async () => {
    mockApi({
      ...signedIn(),
      'GET /v1/admin/backups.settings': () =>
        json({
          settings: {
            ...PINNED,
            last_upload_at: null,
            last_upload_error: 'the directory /srv/copies does not exist on the target machine',
          },
        }),
      'GET /v1/admin/backups.list': () => json({ backups: [{ ...COPY, uploaded: false }] }),
    });
    renderApp('/settings/storage');

    // Not "the backup failed". The local copy is a backup (ADR 0040), and
    // saying otherwise sends an operator looking for a database problem.
    expect(await screen.findByText(/was taken and did not reach the other machine/i)).toBeVisible();
    expect(screen.queryByText(/could not be taken/i)).not.toBeInTheDocument();
    expect(screen.getByText(/not sent/i)).toBeInTheDocument();
  });

  it('claims nothing about a copy the settings cannot speak for', async () => {
    mockApi({
      ...signedIn(),
      'GET /v1/admin/backups.settings': () => json({ settings: PINNED }),
      'GET /v1/admin/backups.list': () => json({ backups: [{ ...COPY, uploaded: null }] }),
    });
    renderApp('/settings/storage');

    expect(await screen.findByText('20261010T080000Z')).toBeInTheDocument();
    // Null is "nothing is known", which is every copy but the last one. A badge
    // saying "not sent" of those would report a problem nobody has.
    expect(screen.queryByText(/not sent/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^sent$/i)).not.toBeInTheDocument();
    expect(screen.getByText(/3 MB/)).toBeInTheDocument();
  });

  it('takes one when asked', async () => {
    const calls = mockApi({
      ...signedIn(),
      'GET /v1/admin/backups.settings': () => json({ settings: PINNED }),
      'GET /v1/admin/backups.list': () => json({ backups: [] }),
      'POST /v1/admin/backups.run': () =>
        json({ ok: true, name: COPY.name, removed: [], error: null, settings: PINNED }),
    });
    renderApp('/settings/storage');
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: /take one now/i }));

    await waitFor(() => expect(calls.some((c) => c.url.endsWith('backups.run'))).toBe(true));
  });
});

describe('somebody who may look but not change', () => {
  it('is offered nothing to press', async () => {
    mockApi({
      ...signedIn(['knowledge.read']),
      'GET /v1/admin/backups.settings': () => json({ settings: PINNED }),
      'GET /v1/admin/backups.list': () => json({ backups: [COPY] }),
    });
    const client = renderApp('/settings/storage');

    // What somebody may do comes from the server, and a control that is drawn
    // and then refused teaches nothing (WEB_UI.md rule 5).
    expect(await screen.findByText('SHA256:zTt+Yq1pQ')).toBeInTheDocument();
    await settled(client);
    expect(screen.queryByRole('button', { name: /^save$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /take one now/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /forget this key/i })).not.toBeInTheDocument();
  });
});
