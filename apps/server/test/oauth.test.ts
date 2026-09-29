import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  AuthorizationServerMetadata,
  ProtectedResourceMetadata,
  TERMS_VERSION,
} from '@knoverge/contracts';
import { parseLedgerKey } from '@knoverge/core';
import { runMigrations } from '@knoverge/db';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.ts';
import { createServices, type Services } from '../src/services.ts';

const migrationsFolder = fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url));
const ok = { status: 'ok' as const };
const ISSUER = 'https://knoverge.example';
const RESOURCE = `${ISSUER}/mcp`;
const REDIRECT = 'https://chat.example/callback';

let container: StartedPostgreSqlContainer;
let dataDir: string;
let services: Services;
let app: FastifyInstance;
let workspaceId: string;

/** A browser: keeps cookies and the CSRF token between requests. */
class Browser {
  cookies = new Map<string, string>();
  csrf: string | undefined;
  private static next = 0;
  readonly remoteAddress = `203.0.113.${(Browser.next += 1) % 250}`;

  async request(opts: InjectOptions & { url: string }) {
    const headers: Record<string, string> = { ...(opts.headers as Record<string, string>) };
    if (this.csrf) headers['x-csrf-token'] = this.csrf;
    const res = await app.inject({
      ...opts,
      headers,
      remoteAddress: this.remoteAddress,
      cookies: Object.fromEntries(this.cookies),
    });
    for (const c of res.cookies) {
      if (c.maxAge === 0 || c.value === '') this.cookies.delete(c.name);
      else this.cookies.set(c.name, c.value);
    }
    return res;
  }

  async fetchCsrf() {
    const res = await this.request({ method: 'GET', url: '/v1/auth/csrf' });
    this.csrf = (res.json() as { token: string }).token;
  }

  post(url: string, payload: unknown, headers?: Record<string, string>) {
    return this.request({
      method: 'POST',
      url,
      payload: payload as Record<string, unknown>,
      ...(headers ? { headers } : {}),
    });
  }
}

/** A person, signed in, with their workspace already chosen. */
async function signIn(email: string, password: string): Promise<Browser> {
  const b = new Browser();
  await b.fetchCsrf();
  const res = await b.post('/v1/auth/login', { email, password });
  expect(res.statusCode).toBe(200);
  await b.fetchCsrf();
  return b;
}

/** A PKCE pair, as a client makes one. */
function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/**
 * Registers a client from an address of its own.
 *
 * Registration is unauthenticated and capped per caller, which is the point of
 * the cap. Sharing one address across a file of tests would make the file's
 * budget one budget, and a test would fail because of how many clients the
 * tests before it happened to register.
 */
let addresses = 0;
function fromSomewhere(): string {
  return `192.0.2.${(addresses += 1) % 250}`;
}

async function registerClient(name = 'ChatGPT'): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/oauth/register',
    remoteAddress: fromSomewhere(),
    payload: { client_name: name, redirect_uris: [REDIRECT] },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { client_id: string }).client_id;
}

function params(clientId: string, challenge: string, extra: Record<string, string> = {}) {
  return {
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: RESOURCE,
    ...extra,
  };
}

/** Consent, as the screen gives it: a signed-in person and a workspace. */
async function consent(
  b: Browser,
  clientId: string,
  challenge: string,
  extra: Record<string, string> = {},
): Promise<string> {
  const res = await b.post(
    '/v1/admin/oauth.consent',
    { ...params(clientId, challenge, extra), workspace_id: workspaceId },
    { 'x-knoverge-workspace': workspaceId },
  );
  expect(res.statusCode).toBe(200);
  const to = new URL((res.json() as { redirect_to: string }).redirect_to);
  return to.searchParams.get('code') as string;
}

/** The token endpoint, spoken to the way a connector speaks to it. */
function form(payload: Record<string, string>) {
  return app.inject({
    method: 'POST',
    url: '/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(payload).toString(),
  });
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'knoverge-oauth-'));
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  services = createServices({
    databaseUrl: container.getConnectionUri(),
    dataDir,
    baseUrl: new URL(ISSUER),
    ledgerKey: parseLedgerKey('a'.repeat(64)),
    tokenPepper: 'b'.repeat(64),
    poolMax: 4,
  });
  await runMigrations(services.database.db, migrationsFolder);
  app = await buildApp({
    version: 'test',
    probes: { database: async () => ok, dataDir: async () => ok },
    services,
    security: { sessionSecret: 'c'.repeat(64), cookieSecure: false },
    rateLimit: { max: 10_000, timeWindow: '1 minute' },
  });

  const b = new Browser();
  await b.fetchCsrf();
  const created = await b.post('/v1/bootstrap', {
    email: 'owner@example.com',
    password: 'correct horse battery staple',
    display_name: 'Owner',
    workspace: { slug: 'personal', name: 'Personal' },
    accepted_terms_version: TERMS_VERSION,
  });
  expect(created.statusCode).toBe(200);
  workspaceId = (created.json() as { workspace_id: string }).workspace_id;
});

afterAll(async () => {
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  await app?.close();
  await services?.close();
  await container?.stop();
});

describe('how a connector finds its way in', () => {
  it('answers an unauthenticated MCP call with a challenge naming the resource document', async () => {
    const res = await app.inject({ method: 'POST', url: '/mcp', payload: {} });
    expect(res.statusCode).toBe(401);
    // Without this a connector handed nothing but the URL has no next step.
    expect(res.headers['www-authenticate']).toBe(
      `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  it('says what the resource is and which server issues tokens for it', async () => {
    for (const path of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
    ]) {
      const res = await app.inject({ method: 'GET', url: path });
      expect(res.statusCode).toBe(200);
      expect(ProtectedResourceMetadata.parse(res.json())).toEqual({
        resource: RESOURCE,
        authorization_servers: [ISSUER],
        bearer_methods_supported: ['header'],
      });
    }
  });

  it('describes an authorization server that requires S256 and nothing weaker', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/.well-known/oauth-authorization-server',
    });
    const doc = AuthorizationServerMetadata.parse(res.json());
    expect(doc.issuer).toBe(ISSUER);
    expect(doc.token_endpoint).toBe(`${ISSUER}/oauth/token`);
    expect(doc.code_challenge_methods_supported).toEqual(['S256']);
    expect(doc.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
  });

  it('keeps the authorization server out of the product API description', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/openapi.json' });
    const paths = Object.keys((res.json() as { paths: Record<string, unknown> }).paths);
    // That document says every route answers in this product's error shape and
    // takes its headers. These do neither.
    expect(paths.filter((p) => p.startsWith('/oauth') || p.startsWith('/.well-known'))).toEqual([]);
  });
});

describe('registration', () => {
  it('is open, and what it hands back cannot do anything', async () => {
    const clientId = await registerClient('Somebody');
    expect(clientId).toHaveLength(32);
    // No workspace, no agent, no token. The only thing it can do is ask.
    const res = await form({
      grant_type: 'refresh_token',
      refresh_token: 'made up',
      client_id: clientId,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('gives a client that asked for one a secret, once', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/oauth/register',
      remoteAddress: fromSomewhere(),
      payload: {
        client_name: 'Confidential',
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: 'client_secret_post',
      },
    });
    const body = res.json() as { client_secret?: string; client_secret_expires_at?: number };
    expect(body.client_secret).toBeTypeOf('string');
    expect(body.client_secret_expires_at).toBe(0);
  });

  it('refuses a redirect URI that is neither https nor a loopback', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/oauth/register',
      remoteAddress: fromSomewhere(),
      payload: { client_name: 'Plain', redirect_uris: ['http://chat.example/callback'] },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('the authorization endpoint', () => {
  it('sends the browser to the consent screen with the request intact', async () => {
    const clientId = await registerClient();
    const { challenge } = pkce();
    const query = new URLSearchParams(params(clientId, challenge, { state: 'xyz' })).toString();
    const res = await app.inject({ method: 'GET', url: `/oauth/authorize?${query}` });
    expect(res.statusCode).toBe(302);
    const to = new URL(res.headers['location'] as string);
    expect(to.pathname).toBe('/oauth/consent');
    expect(to.searchParams.get('client_id')).toBe(clientId);
    expect(to.searchParams.get('state')).toBe('xyz');
  });

  it('refuses a redirect URI the client never registered, without redirecting to it', async () => {
    const clientId = await registerClient();
    const { challenge } = pkce();
    const query = new URLSearchParams({
      ...params(clientId, challenge),
      redirect_uri: 'https://attacker.example/steal',
    }).toString();
    const res = await app.inject({ method: 'GET', url: `/oauth/authorize?${query}` });
    // Redirecting the error would be the open redirection: an unmatched URI is
    // an attacker's URI, and it must not be sent anything at all.
    expect(res.statusCode).toBe(400);
    expect(res.headers['location']).toBeUndefined();
    expect(res.json()).toMatchObject({ error: 'invalid_request' });
  });

  it('refuses a token asked for some other server', async () => {
    const clientId = await registerClient();
    const { challenge } = pkce();
    const query = new URLSearchParams(
      params(clientId, challenge, { resource: 'https://elsewhere.example/mcp' }),
    ).toString();
    const res = await app.inject({ method: 'GET', url: `/oauth/authorize?${query}` });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_request' });
  });
});

describe('consent, and what comes of it', () => {
  it('ends in a token that works on the MCP endpoint', async () => {
    const owner = await signIn('owner@example.com', 'correct horse battery staple');
    const clientId = await registerClient();
    const { verifier, challenge } = pkce();
    const code = await consent(owner, clientId, challenge);

    const token = await form({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: clientId,
      resource: RESOURCE,
    });
    expect(token.statusCode).toBe(200);
    expect(token.headers['cache-control']).toBe('no-store');
    const issued = token.json() as { access_token: string; refresh_token: string };

    const call = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        authorization: `Bearer ${issued.access_token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect(call.statusCode).toBe(200);
  });

  it('creates an agent that proposes, named for the client and the person', async () => {
    const owner = await signIn('owner@example.com', 'correct horse battery staple');
    const clientId = await registerClient('Claude');
    const { challenge } = pkce();
    await consent(owner, clientId, challenge);

    const res = await owner.request({
      method: 'GET',
      url: '/v1/admin/agents.list',
      headers: { 'x-knoverge-workspace': workspaceId },
    });
    const agents = (res.json() as { agents: { name: string; trust_tier: string }[] }).agents;
    const made = agents.find((a) => a.name === 'Claude (Owner)');
    expect(made).toBeDefined();
    // Rule 5 is not restated for connectors: it proposes like every other agent.
    expect(made?.trust_tier).toBe('propose');
  });

  it('consenting again resumes the connection rather than making a second agent', async () => {
    const owner = await signIn('owner@example.com', 'correct horse battery staple');
    const clientId = await registerClient('Twice');
    await consent(owner, clientId, pkce().challenge);
    await consent(owner, clientId, pkce().challenge);

    const res = await owner.request({
      method: 'GET',
      url: '/v1/admin/agents.list',
      headers: { 'x-knoverge-workspace': workspaceId },
    });
    const agents = (res.json() as { agents: { name: string }[] }).agents;
    expect(agents.filter((a) => a.name.startsWith('Twice'))).toHaveLength(1);
  });

  it('is refused to somebody who may not manage agents', async () => {
    const owner = await signIn('owner@example.com', 'correct horse battery staple');
    const invited = await owner.post(
      '/v1/admin/members.add',
      {
        email: 'viewer@example.com',
        role: 'viewer',
        display_name: 'Viewer',
        initial_password: 'tulip stanchion gravel moor',
      },
      { 'x-knoverge-workspace': workspaceId },
    );
    expect(invited.statusCode, invited.body).toBe(200);
    const viewer = await signIn('viewer@example.com', 'tulip stanchion gravel moor');
    const clientId = await registerClient();
    const res = await viewer.post(
      '/v1/admin/oauth.consent',
      { ...params(clientId, pkce().challenge), workspace_id: workspaceId },
      { 'x-knoverge-workspace': workspaceId },
    );
    expect(res.statusCode).toBe(403);
  });
});

describe('the code', () => {
  it('is spent by the first exchange, whether or not that exchange succeeded', async () => {
    const owner = await signIn('owner@example.com', 'correct horse battery staple');
    const clientId = await registerClient();
    const { verifier, challenge } = pkce();
    const code = await consent(owner, clientId, challenge);

    const wrong = await form({
      grant_type: 'authorization_code',
      code,
      code_verifier: pkce().verifier,
      redirect_uri: REDIRECT,
      client_id: clientId,
    });
    expect(wrong.json()).toMatchObject({ error: 'invalid_grant' });

    // The failed attempt spent it. Otherwise somebody holding a stolen code
    // could try verifiers until it expired.
    const right = await form({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: clientId,
    });
    expect(right.statusCode).toBe(400);
    expect(right.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('is refused when the redirect URI is not the one it was issued for', async () => {
    const owner = await signIn('owner@example.com', 'correct horse battery staple');
    const clientId = await registerClient();
    const { verifier, challenge } = pkce();
    const code = await consent(owner, clientId, challenge);
    const res = await form({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: 'https://chat.example/elsewhere',
      client_id: clientId,
    });
    expect(res.json()).toMatchObject({ error: 'invalid_grant' });
  });
});

describe('the refresh token', () => {
  it('rotates, and the new access token works', async () => {
    const owner = await signIn('owner@example.com', 'correct horse battery staple');
    const clientId = await registerClient();
    const { verifier, challenge } = pkce();
    const code = await consent(owner, clientId, challenge);
    const first = (
      await form({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT,
        client_id: clientId,
      })
    ).json() as { refresh_token: string };

    const again = await form({
      grant_type: 'refresh_token',
      refresh_token: first.refresh_token,
      client_id: clientId,
    });
    expect(again.statusCode).toBe(200);
    const next = again.json() as { access_token: string; refresh_token: string };
    expect(next.refresh_token).not.toBe(first.refresh_token);

    const call = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        authorization: `Bearer ${next.access_token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect(call.statusCode).toBe(200);
  });

  it('presented twice ends the connection, because it was captured', async () => {
    const owner = await signIn('owner@example.com', 'correct horse battery staple');
    const clientId = await registerClient();
    const { verifier, challenge } = pkce();
    const code = await consent(owner, clientId, challenge);
    const first = (
      await form({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT,
        client_id: clientId,
      })
    ).json() as { refresh_token: string };
    const second = (
      await form({
        grant_type: 'refresh_token',
        refresh_token: first.refresh_token,
        client_id: clientId,
      })
    ).json() as { access_token: string };

    const replay = await form({
      grant_type: 'refresh_token',
      refresh_token: first.refresh_token,
      client_id: clientId,
    });
    expect(replay.json()).toMatchObject({ error: 'invalid_grant' });

    // Noticing is not enough: the grant has to be gone, and so does the access
    // token it issued to whoever was holding it.
    const call = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        authorization: `Bearer ${second.access_token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect(call.statusCode).toBe(401);
  });
});

describe('disconnecting', () => {
  it('stops the token working, and the connection is gone from the list', async () => {
    const owner = await signIn('owner@example.com', 'correct horse battery staple');
    const clientId = await registerClient('Disconnectable');
    const { verifier, challenge } = pkce();
    const code = await consent(owner, clientId, challenge);
    const issued = (
      await form({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT,
        client_id: clientId,
      })
    ).json() as { access_token: string };

    const list = await owner.request({
      method: 'GET',
      url: '/v1/admin/oauth.grants',
      headers: { 'x-knoverge-workspace': workspaceId },
    });
    const grants = (list.json() as { grants: { grant_id: string; client_name: string }[] }).grants;
    const mine = grants.find((g) => g.client_name === 'Disconnectable');
    expect(mine).toBeDefined();

    const off = await owner.post(
      '/v1/admin/oauth.disconnect',
      { grant_id: mine?.grant_id },
      { 'x-knoverge-workspace': workspaceId },
    );
    expect(off.json()).toEqual({ disconnected: true });

    const call = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        authorization: `Bearer ${issued.access_token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect(call.statusCode).toBe(401);
  });
});
