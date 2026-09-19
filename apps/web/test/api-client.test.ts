import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiRequestError, apiGet, apiPost, resetCsrfToken } from '../src/api/client.ts';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface Call {
  url: string;
  method: string;
  csrf: string | undefined;
}

function mockFetch(handler: (call: Call) => Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const call: Call = {
        url: String(input),
        method: init?.method ?? 'GET',
        csrf: (init?.headers as Record<string, string> | undefined)?.['x-csrf-token'],
      };
      calls.push(call);
      return handler(call);
    }),
  );
  return calls;
}

beforeEach(() => resetCsrfToken());
afterEach(() => vi.unstubAllGlobals());

describe('apiGet', () => {
  it('returns the parsed body', async () => {
    mockFetch(() => json({ ok: true }));
    await expect(apiGet('/v1/thing')).resolves.toEqual({ ok: true });
  });

  it('throws ApiRequestError carrying the code', async () => {
    mockFetch(() => json({ code: 'NOT_FOUND', message: 'gone', retryable: false }, 404));
    await expect(apiGet('/v1/thing')).rejects.toMatchObject({
      name: 'ApiRequestError',
      code: 'NOT_FOUND',
      status: 404,
    });
  });

  it('falls back to a generic error when the body is not the shared payload', async () => {
    mockFetch(() => new Response('<html>502</html>', { status: 502 }));
    const error = await apiGet('/v1/thing').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect((error as ApiRequestError).code).toBe('INTERNAL_ERROR');
    expect((error as ApiRequestError).retryable).toBe(true);
  });
});

describe('apiPost', () => {
  it('fetches a CSRF token once and reuses it', async () => {
    const calls = mockFetch((call) =>
      call.url === '/v1/auth/csrf' ? json({ token: 'token-1' }) : json({ ok: true }),
    );
    await apiPost('/v1/a', {});
    await apiPost('/v1/b', {});
    expect(calls.filter((c) => c.url === '/v1/auth/csrf')).toHaveLength(1);
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.csrf)).toEqual([
      'token-1',
      'token-1',
    ]);
  });

  it('refreshes a rejected cached token and retries once', async () => {
    let issued = 0;
    const calls = mockFetch((call) => {
      if (call.url === '/v1/auth/csrf') {
        issued += 1;
        return json({ token: issued === 1 ? 'stale' : 'fresh' });
      }
      // The token works for the first request, then the CSRF cookie is invalidated.
      if (call.url === '/v1/a') return json({ ok: true });
      return call.csrf === 'fresh'
        ? json({ ok: true })
        : json({ code: 'FORBIDDEN', message: 'request rejected', retryable: false }, 403);
    });
    await apiPost('/v1/a', {});
    expect(await apiPost('/v1/b', {})).toEqual({ ok: true });
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts.map((c) => c.csrf)).toEqual(['stale', 'stale', 'fresh']);
  });

  it('does not retry when the token was fetched inside the same call', async () => {
    const calls = mockFetch((call) =>
      call.url === '/v1/auth/csrf'
        ? json({ token: 'token-1' })
        : json(
            { code: 'FORBIDDEN', message: 'bootstrap already completed', retryable: false },
            403,
          ),
    );
    await expect(apiPost('/v1/bootstrap', {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('retries at most once and reports the second failure', async () => {
    const calls = mockFetch((call) => {
      if (call.url === '/v1/auth/csrf') return json({ token: 'any' });
      if (call.url === '/v1/prime') return json({ ok: true });
      return json({ code: 'FORBIDDEN', message: 'request rejected', retryable: false }, 403);
    });
    await apiPost('/v1/prime', {});
    await expect(apiPost('/v1/again', {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(calls.filter((c) => c.url === '/v1/again')).toHaveLength(2);
  });
});
