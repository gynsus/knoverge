import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MeResponse } from '@knoverge/contracts';

import { TERMS_VERSION } from '@knoverge/contracts';

import { resetCsrfToken } from '../src/api/client.ts';
import { App } from '../src/App.tsx';
import { createI18n } from '../src/i18n.ts';

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mockApi(routes: Record<string, Handler>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET';
      calls.push({ url, ...(init ? { init } : {}) });
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
const READY = {
  status: 'ok',
  version: 'test',
  checks: { database: { status: 'ok' }, data_dir: { status: 'ok' } },
};

function renderApp(path = '/') {
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
  it('parses the canned session response', () => {
    expect(() => MeResponse.parse(ME)).not.toThrow();
  });
});

beforeEach(() => resetCsrfToken());
afterEach(() => vi.unstubAllGlobals());

describe('first run', () => {
  it('redirects to the setup page and creates the administrator', async () => {
    let bootstrapped = false;
    const calls = mockApi({
      'GET /v1/auth/status': () =>
        json({ bootstrap_required: !bootstrapped, authenticated: bootstrapped }),
      'GET /v1/auth/csrf': () => json({ token: 'csrf-1' }),
      'POST /v1/bootstrap': () => {
        bootstrapped = true;
        return json({ user_id: ME.user.id, workspace_id: ME.memberships[0]!.workspace_id });
      },
      'GET /v1/auth/me': () => json(ME),
      'GET /health/ready': () => json(READY),
    });
    renderApp('/');
    expect(await screen.findByRole('heading', { name: 'Set up Knoverge' })).toBeInTheDocument();

    const user = userEvent.setup();

    // Step one: the terms, with nothing else to do while reading them.
    const steps = screen.getByRole('list', { name: 'Setup steps' });
    expect(within(steps).getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByRole('heading', { name: /Terms of use/ })).toBeInTheDocument();
    // Each clause is there to be read, not summarised into one paragraph.
    expect(screen.getByText('Nothing is sent anywhere', { exact: false })).toBeInTheDocument();
    // Nothing moves until they are accepted.
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    await user.click(screen.getByLabelText(/accept them/));
    await user.click(screen.getByRole('button', { name: 'Next' }));

    // Both groups read as headings and stand apart from the first field under
    // them. A legend takes no part in the grid gap, so this is not automatic.
    const legend = screen.getByText('Administrator', { selector: 'legend' });
    expect(legend.className).toContain('mb-3');
    expect(legend.className).toContain('font-semibold');
    await user.type(screen.getByLabelText('Your name'), 'Owner');
    await user.type(screen.getByLabelText('Email'), 'owner@example.com');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery staple');
    await user.click(screen.getByRole('button', { name: 'Next' }));

    // Step three: the workspace, and only now is anything sent.
    expect(calls.some((c) => c.url === '/v1/bootstrap')).toBe(false);
    await user.type(screen.getByLabelText('Workspace name'), 'Personal Knowledge');
    expect(screen.getByLabelText('Workspace identifier')).toHaveValue('personal-knowledge');
    await user.click(screen.getByRole('button', { name: 'Create administrator and workspace' }));

    expect(await screen.findByText('Your workspaces')).toBeInTheDocument();
    const post = calls.find((c) => c.url === '/v1/bootstrap');
    expect(post?.init?.headers).toMatchObject({ 'x-csrf-token': 'csrf-1' });
    expect(JSON.parse(post?.init?.body as string)).toMatchObject({
      email: 'owner@example.com',
      display_name: 'Owner',
      locale: 'en',
      workspace: { slug: 'personal-knowledge', name: 'Personal Knowledge' },
      // Which version was shown and accepted, recorded against the user: an
      // unrecorded click protects nobody.
      accepted_terms_version: TERMS_VERSION,
    });
  });

  it('lets somebody go back without losing what they typed', async () => {
    mockApi({
      'GET /v1/auth/status': () => json({ bootstrap_required: true, authenticated: false }),
      'GET /v1/auth/csrf': () => json({ token: 'csrf-1' }),
    });
    renderApp('/');
    await screen.findByRole('heading', { name: 'Set up Knoverge' });

    const user = userEvent.setup();
    await user.click(screen.getByLabelText(/accept them/));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.type(screen.getByLabelText('Your name'), 'Owner');

    await user.click(screen.getByRole('button', { name: 'Back' }));
    // The steps are a way of asking, not a sequence of commitments.
    expect(screen.getByLabelText(/accept them/)).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByLabelText('Your name')).toHaveValue('Owner');
  });
});

describe('sign in', () => {
  it('shows the login page for anonymous users and the error for wrong credentials', async () => {
    mockApi({
      'GET /v1/auth/status': () => json({ bootstrap_required: false, authenticated: false }),
      'GET /v1/auth/csrf': () => json({ token: 'csrf-2' }),
      'POST /v1/auth/login': () =>
        json(
          { code: 'UNAUTHENTICATED', message: 'invalid email or password', retryable: false },
          401,
        ),
    });
    renderApp('/');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Email'), 'owner@example.com');
    await user.type(screen.getByLabelText('Password'), 'wrong password!!');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    // One code stands for three different failures (wrong password, expired
    // session, wrong current password), so the text names none of them.
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Please sign in again, or check the details you entered.',
    );
  });

  it('signs in, shows the home page and signs out', async () => {
    let authenticated = false;
    mockApi({
      'GET /v1/auth/status': () => json({ bootstrap_required: false, authenticated }),
      'GET /v1/auth/csrf': () => json({ token: 'csrf-3' }),
      'POST /v1/auth/login': () => {
        authenticated = true;
        return json(ME);
      },
      'POST /v1/auth/logout': () => {
        authenticated = false;
        return json({ ok: true });
      },
      'GET /v1/auth/me': () => json(ME),
      'GET /health/ready': () => json(READY),
    });
    renderApp('/');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Email'), 'owner@example.com');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery staple');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Your workspaces')).toBeInTheDocument();
    expect(screen.getByText(/Personal/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument(),
    );
  });

  it('sends signed-in users away from the setup page', async () => {
    mockApi({
      'GET /v1/auth/status': () => json({ bootstrap_required: false, authenticated: true }),
      'GET /v1/auth/me': () => json(ME),
      'GET /health/ready': () => json(READY),
    });
    renderApp('/setup');
    expect(await screen.findByText('Your workspaces')).toBeInTheDocument();
  });
});

describe('the password field on first run', () => {
  /** The wizard, walked as far as the step the password is on. */
  async function toAdministratorStep(user: ReturnType<typeof userEvent.setup>) {
    await screen.findByRole('heading', { name: 'Set up Knoverge' });
    await user.click(screen.getByLabelText(/accept them/));
    await user.click(screen.getByRole('button', { name: 'Next' }));
  }

  /**
   * A clipboard, since jsdom has none.
   *
   * Installed after `userEvent.setup()`, which puts its own in place: one
   * installed before is quietly replaced, and the test then measures
   * user-event's clipboard rather than the page's use of it.
   */
  function stubClipboard(): { written: string[]; fail?: boolean } {
    const state: { written: string[]; fail?: boolean } = { written: [] };
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          if (state.fail) throw new Error('refused');
          state.written.push(text);
        },
      },
    });
    return state;
  }

  it('generates a password, shows it, copies it and says so', async () => {
    mockApi({
      'GET /v1/auth/status': () => json({ bootstrap_required: true, authenticated: false }),
      'GET /v1/auth/csrf': () => json({ token: 'csrf-1' }),
    });
    renderApp('/');
    const user = userEvent.setup();
    const clipboard = stubClipboard();
    await toAdministratorStep(user);
    const field = screen.getByLabelText('Password') as HTMLInputElement;
    // Hidden to begin with, as a password field is.
    expect(field.type).toBe('password');

    await user.click(screen.getByRole('button', { name: 'Generate' }));
    await waitFor(() => expect(clipboard.written).toHaveLength(1));
    expect(field.value).toBe(clipboard.written[0]);
    expect(field.value.length).toBeGreaterThanOrEqual(12);
    // Generating reveals: a password copied and hidden is one nobody can
    // check they still have.
    expect(field.type).toBe('text');
    expect(await screen.findByRole('status')).toHaveTextContent('copied to the clipboard');
  });

  it('copies again when the password is revealed', async () => {
    mockApi({
      'GET /v1/auth/status': () => json({ bootstrap_required: true, authenticated: false }),
      'GET /v1/auth/csrf': () => json({ token: 'csrf-1' }),
    });
    renderApp('/');
    const user = userEvent.setup();
    const clipboard = stubClipboard();
    await toAdministratorStep(user);
    await user.type(screen.getByLabelText('Password'), 'typed by a person');
    await user.click(screen.getByRole('button', { name: 'Show the password and copy it' }));
    await waitFor(() => expect(clipboard.written).toEqual(['typed by a person']));
    expect((screen.getByLabelText('Password') as HTMLInputElement).type).toBe('text');

    // Hiding does not copy: there is no reason to, and a clipboard that
    // changes when somebody hides something is a surprise.
    await user.click(screen.getByRole('button', { name: 'Hide the password' }));
    expect(clipboard.written).toHaveLength(1);
    expect((screen.getByLabelText('Password') as HTMLInputElement).type).toBe('password');
  });

  it('says when the clipboard refused, rather than claiming it worked', async () => {
    mockApi({
      'GET /v1/auth/status': () => json({ bootstrap_required: true, authenticated: false }),
      'GET /v1/auth/csrf': () => json({ token: 'csrf-1' }),
    });
    renderApp('/');
    const user = userEvent.setup();
    const clipboard = stubClipboard();
    clipboard.fail = true;
    await toAdministratorStep(user);
    await user.click(screen.getByRole('button', { name: 'Generate' }));
    // The password is still generated and still in the field; only the copy
    // failed, and the message says which.
    expect((screen.getByLabelText('Password') as HTMLInputElement).value.length).toBeGreaterThan(
      11,
    );
    expect(await screen.findByRole('status')).toHaveTextContent('copy it from the field');
  });
});
