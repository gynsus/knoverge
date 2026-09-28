import { AttachmentsResponse, SingleAttachmentResponse } from '@knoverge/contracts';
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
      calls.push({ url, method, body: init?.body });
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
const ATTACHMENT_ID = 'att_01J8Z3M4Q9V0X7K2B5N6P8R1T3';

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

function signedIn(permissions: string[]): Record<string, Handler> {
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
  };
}

const SIGNED_IN = signedIn(['workspace.admin', 'knowledge.read', 'knowledge.write']);

const FILE = {
  id: ATTACHMENT_ID,
  workspace_id: WORKSPACE_ID,
  content_hash: 'sha256:' + 'c'.repeat(64),
  media_type: 'application/pdf',
  size_bytes: 2_097_152,
  filename: 'runbook.pdf',
  original_uri: null,
  extraction_state: 'pending' as const,
  extraction_error: null,
  uploaded_by_actor_id: 'act_01J8Z3M4Q9V0X7K2B5N6P8R1T3',
  created_at: '2026-09-28T09:00:00.000Z',
};

const ITEM = {
  id: 'kn_01J8Z3M4Q9V0X7K2B5N6P8R1T3',
  workspace_id: WORKSPACE_ID,
  slug: 'runbook',
  markdown_path: 'knowledge/_uncategorised/runbook.md',
  title: 'runbook',
  type: 'document',
  status: 'active',
  language: 'en',
  current_revision_id: 'rev_01J8Z3M4Q9V0X7K2B5N6P8R1T3',
  revision_number: 1,
  review_state: 'human_reviewed',
  evidence_state: 'source_backed',
  disputed: false,
  stale: false,
  categories: [],
  tags: [],
  valid_from: null,
  valid_until: null,
  observed_at: null,
  created_at: '2026-09-28T09:01:00.000Z',
  updated_at: '2026-09-28T09:01:00.000Z',
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
  it('parse as what the server answers', () => {
    expect(() => AttachmentsResponse.parse({ attachments: [FILE] })).not.toThrow();
    expect(() => SingleAttachmentResponse.parse({ attachment: FILE, items: [ITEM] })).not.toThrow();
  });
});

beforeEach(() => {
  resetCsrfToken();
  window.localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe('the files a workspace holds', () => {
  it('says what became of each, which is the reason this screen exists', async () => {
    mockApi({
      ...SIGNED_IN,
      'GET /v1/admin/attachments.list': () =>
        json({
          attachments: [
            { ...FILE, extraction_state: 'extracted' },
            {
              ...FILE,
              id: 'att_01J8Z3M4Q9V0X7K2B5N6P8R1T4',
              filename: 'diagram.png',
              media_type: 'image/png',
              extraction_state: 'unsupported',
            },
          ],
        }),
    });
    renderApp('/files');

    expect(await screen.findByText('runbook.pdf')).toBeInTheDocument();
    expect(screen.getByText('Read')).toBeInTheDocument();
    // Not a failure and not coloured like one: the file is kept and can be
    // downloaded, and a later version may learn to read it.
    expect(screen.getByText('Not readable here')).toBeInTheDocument();
    // A size a person reads, from the number the server counts in. Both rows
    // carry it, which is why this counts them rather than expecting one.
    expect(screen.getAllByText('2 MB')).toHaveLength(2);
  });

  it('opens one and says what it produced, by name and not by id', async () => {
    mockApi({
      ...SIGNED_IN,
      'GET /v1/admin/attachments.list': () =>
        json({ attachments: [{ ...FILE, extraction_state: 'extracted' }] }),
      [`GET /v1/admin/attachments.get?attachment_id=${ATTACHMENT_ID}`]: () =>
        json({ attachment: { ...FILE, extraction_state: 'extracted' }, items: [ITEM] }),
    });
    renderApp(`/files?file=${ATTACHMENT_ID}`);

    const drawer = await screen.findByRole('dialog');
    expect(await within(drawer).findByText('Made from this file')).toBeInTheDocument();
    // A link and not an id: the whole point of recording where knowledge came
    // from is that somebody can go and read it.
    const link = within(drawer).getByRole('link', { name: 'runbook' });
    expect(link).toHaveAttribute('href', `/knowledge?item=${ITEM.id}`);
    // And the original, downloaded rather than rendered.
    expect(within(drawer).getByRole('link', { name: /Download/ })).toHaveAttribute(
      'href',
      `/v1/admin/attachments.download?attachment_id=${ATTACHMENT_ID}`,
    );
  });

  it('explains a state rather than leaving a badge to be guessed at', async () => {
    mockApi({
      ...SIGNED_IN,
      'GET /v1/admin/attachments.list': () =>
        json({ attachments: [{ ...FILE, extraction_state: 'proposed' }] }),
      [`GET /v1/admin/attachments.get?attachment_id=${ATTACHMENT_ID}`]: () =>
        json({ attachment: { ...FILE, extraction_state: 'proposed' }, items: [] }),
    });
    renderApp(`/files?file=${ATTACHMENT_ID}`);

    const drawer = await screen.findByRole('dialog');
    // An agent brought it, so the text is in the review queue: the screen says
    // so instead of showing an empty list of what the file produced.
    expect(await within(drawer).findByText(/waiting in the review queue/i)).toBeInTheDocument();
    expect(within(drawer).getByText('Nothing yet.')).toBeInTheDocument();
  });

  it('sends the file somebody chose', async () => {
    const calls = mockApi({
      ...SIGNED_IN,
      'GET /v1/admin/attachments.list': () => json({ attachments: [] }),
      'POST /v1/admin/attachments.upload': () => json({ attachment: FILE, created: true }),
      [`GET /v1/admin/attachments.get?attachment_id=${ATTACHMENT_ID}`]: () =>
        json({ attachment: FILE, items: [] }),
    });
    const user = userEvent.setup();
    renderApp('/files');

    const file = new File(['Until five, every weekday.\n'], 'hours.txt', { type: 'text/plain' });
    await user.upload(await screen.findByLabelText('Choose a file'), file);

    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith('/v1/admin/attachments.upload'))).toBe(true),
    );
    const sent = calls.find((c) => c.url.endsWith('/v1/admin/attachments.upload'))!;
    // As a form and not as JSON, with the part the route reads named `file`.
    expect(sent.body).toBeInstanceOf(FormData);
    expect((sent.body as FormData).get('file')).toBe(file);
    // And the drawer opens on what was just added, because the question somebody
    // has next is what became of it.
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('offers to read again what nothing could read, and says why that is a thing', async () => {
    const calls = mockApi({
      ...SIGNED_IN,
      'GET /v1/admin/attachments.list': () =>
        json({
          attachments: [
            { ...FILE, extraction_state: 'unsupported' },
            {
              ...FILE,
              id: 'att_01J8Z3M4Q9V0X7K2B5N6P8R1T4',
              filename: 'broken.pdf',
              extraction_state: 'failed',
            },
            {
              ...FILE,
              id: 'att_01J8Z3M4Q9V0X7K2B5N6P8R1T5',
              filename: 'read.md',
              extraction_state: 'extracted',
            },
          ],
        }),
      'POST /v1/admin/attachments.reread': () => json({ queued: 2 }),
    });
    const user = userEvent.setup({ delay: null });
    renderApp('/files');

    // Two, not three: the one that already became an item would become a
    // second one.
    const button = await screen.findByRole('button', { name: 'Read 2 files again' });
    // The reason it exists at all, said rather than left to be worked out.
    expect(screen.getByText(/only looks at files nobody has read yet/i)).toBeInTheDocument();

    await user.click(button);
    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith('/v1/admin/attachments.reread'))).toBe(true),
    );
    // No id: somebody who has just connected a model means all of them.
    const sent = calls.find((c) => c.url.endsWith('/v1/admin/attachments.reread'))!;
    expect(JSON.parse(sent.body as string)).toEqual({});
  });

  it('offers nothing to read again when everything was read', async () => {
    mockApi({
      ...SIGNED_IN,
      'GET /v1/admin/attachments.list': () =>
        json({ attachments: [{ ...FILE, extraction_state: 'extracted' }] }),
    });
    renderApp('/files');

    expect(await screen.findByText('runbook.pdf')).toBeInTheDocument();
    // A button that would do nothing is worse than no button.
    expect(screen.queryByRole('button', { name: /read .* again/i })).not.toBeInTheDocument();
  });

  it('reads one file again from its own drawer, naming that file', async () => {
    const calls = mockApi({
      ...SIGNED_IN,
      'GET /v1/admin/attachments.list': () =>
        json({ attachments: [{ ...FILE, extraction_state: 'unsupported' }] }),
      [`GET /v1/admin/attachments.get?attachment_id=${ATTACHMENT_ID}`]: () =>
        json({ attachment: { ...FILE, extraction_state: 'unsupported' }, items: [] }),
      'POST /v1/admin/attachments.reread': () => json({ queued: 1 }),
    });
    const user = userEvent.setup({ delay: null });
    renderApp(`/files?file=${ATTACHMENT_ID}`);

    const drawer = await screen.findByRole('dialog');
    await user.click(await within(drawer).findByRole('button', { name: 'Read it again' }));

    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith('/v1/admin/attachments.reread'))).toBe(true),
    );
    const sent = calls.find((c) => c.url.endsWith('/v1/admin/attachments.reread'))!;
    expect(JSON.parse(sent.body as string)).toEqual({ attachment_id: ATTACHMENT_ID });
  });

  it('offers no upload to somebody who may not write', async () => {
    mockApi({
      ...signedIn(['knowledge.read']),
      'GET /v1/admin/attachments.list': () => json({ attachments: [] }),
    });
    renderApp('/files');

    expect(await screen.findByText(/No files yet/)).toBeInTheDocument();
    // What somebody may do comes from the server, and a control that refuses is
    // worse than one that is not there.
    expect(screen.queryByRole('button', { name: 'Choose a file' })).not.toBeInTheDocument();
  });
});
