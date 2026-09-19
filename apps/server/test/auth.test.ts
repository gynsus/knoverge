import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { AuthStatusResponse, MeResponse, SessionsResponse } from '@knoverge/contracts';
import { MAX_FAILED_LOGINS, parseLedgerKey } from '@knoverge/core';
import { runMigrations } from '@knoverge/db';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.ts';
import { CSRF_COOKIE, SESSION_COOKIE } from '../src/plugins/security.ts';
import { createServices, type Services } from '../src/services.ts';

const migrationsFolder = fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url));
const ok = { status: 'ok' as const };

let container: StartedPostgreSqlContainer;
let services: Services;
let app: FastifyInstance;

/** A browser: keeps cookies and the CSRF token between requests. */
class Browser {
  cookies = new Map<string, string>();
  csrf: string | undefined;

  async request(opts: InjectOptions & { url: string }) {
    const headers: Record<string, string> = { ...(opts.headers as Record<string, string>) };
    if (this.csrf) headers['x-csrf-token'] = this.csrf;
    const res = await app.inject({ ...opts, headers, cookies: Object.fromEntries(this.cookies) });
    for (const c of res.cookies) {
      if (c.maxAge === 0 || c.value === '') this.cookies.delete(c.name);
      else this.cookies.set(c.name, c.value);
    }
    return res;
  }

  async fetchCsrf() {
    const res = await this.request({ method: 'GET', url: '/v1/auth/csrf' });
    expect(res.statusCode).toBe(200);
    this.csrf = (res.json() as { token: string }).token;
  }

  post(url: string, payload: unknown) {
    return this.request({ method: 'POST', url, payload: payload as Record<string, unknown> });
  }
}

const ADMIN = {
  email: 'Owner@Example.com',
  password: 'correct horse battery staple',
  display_name: 'Owner',
};

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  services = createServices({
    databaseUrl: container.getConnectionUri(),
    ledgerKey: parseLedgerKey('d'.repeat(64)),
    tokenPepper: 'f'.repeat(64),
    poolMax: 4,
  });
  await runMigrations(services.database.db, migrationsFolder);
  app = await buildApp({
    version: 'test',
    probes: { database: async () => ok, dataDir: async () => ok },
    services,
    security: { sessionSecret: 'e'.repeat(64), cookieSecure: false },
  });
});

afterAll(async () => {
  await app?.close();
  await services?.close();
  await container?.stop();
});

describe('bootstrap', () => {
  it('reports bootstrap as required on a fresh install', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/auth/status' });
    expect(AuthStatusResponse.parse(res.json())).toEqual({
      bootstrap_required: true,
      authenticated: false,
    });
  });

  it('rejects bootstrap without a CSRF token', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/bootstrap', payload: {} });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('FORBIDDEN');
  });

  it('validates the body', async () => {
    const b = new Browser();
    await b.fetchCsrf();
    const res = await b.post('/v1/bootstrap', {
      email: 'nope',
      password: 'short',
      display_name: '',
      workspace: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
  });

  it('creates the first administrator and workspace and signs them in', async () => {
    const b = new Browser();
    await b.fetchCsrf();
    const res = await b.post('/v1/bootstrap', {
      ...ADMIN,
      workspace: { slug: 'personal', name: 'Personal' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(b.cookies.has(SESSION_COOKIE)).toBe(true);
    const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE)!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Lax');

    const me = await b.request({ method: 'GET', url: '/v1/auth/me' });
    const body = MeResponse.parse(me.json());
    expect(body.user.email).toBe('owner@example.com');
    expect(body.memberships).toEqual([
      expect.objectContaining({ workspace_slug: 'personal', role: 'owner' }),
    ]);

    const status = await app.inject({ method: 'GET', url: '/v1/auth/status' });
    expect(status.json()).toEqual({ bootstrap_required: false, authenticated: false });

    const ledger = await services.ledger.verify(body.memberships[0]!.workspace_id);
    expect(ledger).toEqual({ ok: true, count: 3 });
  });

  it('leaves nothing behind when bootstrap fails after validation', async () => {
    // A second bootstrap is refused inside the transaction; no workspace or user leaks.
    const before = await services.repositories.workspaces.list();
    const b = new Browser();
    await b.fetchCsrf();
    await b.post('/v1/bootstrap', {
      ...ADMIN,
      email: 'leak@example.com',
      workspace: { slug: 'leak', name: 'Leak' },
    });
    expect(await services.repositories.workspaces.list()).toHaveLength(before.length);
    expect(await services.repositories.users.findByEmail('leak@example.com')).toBeNull();
  });

  it('refuses a second bootstrap', async () => {
    const b = new Browser();
    await b.fetchCsrf();
    const res = await b.post('/v1/bootstrap', {
      ...ADMIN,
      email: 'x@example.com',
      workspace: { slug: 'x', name: 'X' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('FORBIDDEN');
  });
});

describe('login and sessions', () => {
  it('rejects wrong credentials with 401 and no cookie', async () => {
    const b = new Browser();
    await b.fetchCsrf();
    const res = await b.post('/v1/auth/login', { email: ADMIN.email, password: 'wrong password!' });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('UNAUTHENTICATED');
    expect(b.cookies.has(SESSION_COOKIE)).toBe(false);
    const unknown = await b.post('/v1/auth/login', {
      email: 'nobody@example.com',
      password: 'whatever whatever',
    });
    expect(unknown.statusCode).toBe(401);
  });

  it('signs in, lists sessions, changes the password and revokes other sessions', async () => {
    const first = new Browser();
    await first.fetchCsrf();
    expect(
      (await first.post('/v1/auth/login', { email: ADMIN.email, password: ADMIN.password }))
        .statusCode,
    ).toBe(200);
    const second = new Browser();
    await second.fetchCsrf();
    expect(
      (await second.post('/v1/auth/login', { email: ADMIN.email, password: ADMIN.password }))
        .statusCode,
    ).toBe(200);

    const list = SessionsResponse.parse(
      (await first.request({ method: 'GET', url: '/v1/auth/sessions' })).json(),
    );
    expect(list.sessions.length).toBeGreaterThanOrEqual(2);
    expect(list.sessions.filter((s) => s.current)).toHaveLength(1);

    const change = await first.post('/v1/auth/password', {
      current_password: ADMIN.password,
      new_password: 'a brand new passphrase',
    });
    expect(change.statusCode, change.body).toBe(200);
    expect((await first.request({ method: 'GET', url: '/v1/auth/me' })).statusCode).toBe(200);
    expect((await second.request({ method: 'GET', url: '/v1/auth/me' })).statusCode).toBe(401);

    const old = new Browser();
    await old.fetchCsrf();
    expect(
      (await old.post('/v1/auth/login', { email: ADMIN.email, password: ADMIN.password }))
        .statusCode,
    ).toBe(401);
    expect(
      (await old.post('/v1/auth/login', { email: ADMIN.email, password: 'a brand new passphrase' }))
        .statusCode,
    ).toBe(200);

    const logout = await first.post('/v1/auth/logout', {});
    expect(logout.statusCode).toBe(200);
    expect(first.cookies.has(SESSION_COOKIE)).toBe(false);
    expect((await first.request({ method: 'GET', url: '/v1/auth/me' })).statusCode).toBe(401);
  });

  it('requires a CSRF token for state-changing requests even when signed in', async () => {
    const b = new Browser();
    await b.fetchCsrf();
    expect(
      (await b.post('/v1/auth/login', { email: ADMIN.email, password: 'a brand new passphrase' }))
        .statusCode,
    ).toBe(200);
    b.csrf = undefined;
    b.cookies.delete(CSRF_COOKIE);
    const res = await b.post('/v1/auth/logout', {});
    expect(res.statusCode).toBe(403);
  });

  it('locks the account after repeated failures', async () => {
    const b = new Browser();
    await b.fetchCsrf();
    let last = 0;
    for (let i = 0; i < MAX_FAILED_LOGINS; i += 1) {
      last = (await b.post('/v1/auth/login', { email: ADMIN.email, password: `bad ${i}` }))
        .statusCode;
      if (last === 429) break;
    }
    const locked = await b.post('/v1/auth/login', {
      email: ADMIN.email,
      password: 'a brand new passphrase',
    });
    expect([locked.statusCode, last]).toContain(429);
  });
});

describe('hardening', () => {
  it('sets security headers', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/auth/status' });
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('serves an OpenAPI document with the auth routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/openapi.json' });
    expect(res.statusCode).toBe(200);
    const doc = res.json() as { paths: Record<string, unknown> };
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining(['/v1/auth/login', '/v1/bootstrap']),
    );
  });

  it('returns the shared error shape for unknown routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/nothing' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ code: 'NOT_FOUND', message: 'Route not found', retryable: false });
  });
});
