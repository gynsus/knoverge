import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { EventsListResponse, ProposalResult, TOOLS } from '@knoverge/contracts';
import { parseLedgerKey } from '@knoverge/core';
import { runMigrations } from '@knoverge/db';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.ts';
import { createServices, type Services } from '../src/services.ts';

const migrationsFolder = fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url));
const ok = { status: 'ok' as const };

let container: StartedPostgreSqlContainer;
let dataDir: string;
let services: Services;
let app: FastifyInstance;
let baseUrl: string;
let admin: Browser;
let agentToken: string;

class Browser {
  cookies = new Map<string, string>();
  csrf: string | undefined;

  async request(opts: InjectOptions & { url: string }) {
    const headers: Record<string, string> = { ...(opts.headers as Record<string, string>) };
    if (this.csrf) headers['x-csrf-token'] = this.csrf;
    const res = await app.inject({ ...opts, headers, cookies: Object.fromEntries(this.cookies) });
    for (const c of res.cookies) {
      if (c.value === '') this.cookies.delete(c.name);
      else this.cookies.set(c.name, c.value);
    }
    return res;
  }

  post(url: string, payload: unknown) {
    return this.request({ method: 'POST', url, payload: payload as Record<string, unknown> });
  }

  get(url: string) {
    return this.request({ method: 'GET', url });
  }
}

/** A real MCP client, speaking Streamable HTTP to the real endpoint. */
async function connect(token: string): Promise<Client> {
  const client = new Client({ name: 'knoverge-test', version: 'test' });
  // The SDK's optional callbacks are required in its own `Transport` type,
  // which `exactOptionalPropertyTypes` refuses; the same mismatch the server
  // side works around.
  await client.connect(
    new StreamableHTTPClientTransport(new URL('/mcp', baseUrl), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }) as unknown as Transport,
  );
  return client;
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'knoverge-test-'));
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  services = createServices({
    databaseUrl: container.getConnectionUri(),
    dataDir,
    ledgerKey: parseLedgerKey('d4'.repeat(32)),
    tokenPepper: 'e5'.repeat(32),
    poolMax: 4,
  });
  await runMigrations(services.database.db, migrationsFolder);
  app = await buildApp({
    version: 'test',
    probes: { database: async () => ok, dataDir: async () => ok },
    services,
    security: { sessionSecret: 'f6'.repeat(32), cookieSecure: false },
  });
  // A real socket, because the MCP client speaks HTTP rather than inject().
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  baseUrl = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';

  admin = new Browser();
  admin.csrf = ((await admin.get('/v1/auth/csrf')).json() as { token: string }).token;
  expect(
    (
      await admin.post('/v1/bootstrap', {
        email: 'owner@example.com',
        password: 'correct horse battery staple',
        display_name: 'Owner',
        workspace: { slug: 'personal', name: 'Personal' },
      })
    ).statusCode,
  ).toBe(200);

  const created = await admin.post('/v1/admin/agents.create', {
    name: 'MCP client',
    trust_tier: 'propose',
  });
  const agentId = (created.json() as { agent: { id: string } }).agent.id;
  const issued = await admin.post('/v1/admin/agents.credentials.issue', { agent_id: agentId });
  agentToken = (issued.json() as { token: string }).token;
}, 180_000);

afterAll(async () => {
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  await app?.close();
  await services?.close();
  await container?.stop();
});

describe('the MCP endpoint', () => {
  it('advertises every tool the contract defines', async () => {
    const client = await connect(agentToken);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(TOOLS.map((t) => t.name).sort());
      const get = tools.find((t) => t.name === 'knowledge_get')!;
      // The description an agent reads when choosing is the contract's own.
      expect(get.description).toBe(TOOLS.find((t) => t.name === 'knowledge_get')!.description);
      expect(get.annotations?.readOnlyHint).toBe(true);
      expect(get.inputSchema.properties).toHaveProperty('item_id');
      // A write tool says so, which is what a client uses to decide whether
      // to ask a person first.
      expect(
        tools.find((t) => t.name === 'knowledge_propose_create')!.annotations?.readOnlyHint,
      ).toBe(false);
    } finally {
      await client.close();
    }
  });

  it('runs a tool, and answers with the same shape the HTTP route answers', async () => {
    const item = (
      await admin.post('/v1/admin/knowledge.create', {
        title: 'Reachable over MCP',
        body: 'Read me through the endpoint.',
        type: 'fact',
      })
    ).json() as { item: { id: string } };

    const client = await connect(agentToken);
    try {
      const result = await client.callTool({
        name: 'knowledge_get',
        arguments: { item_id: item.item.id },
      });
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as { item: { title: string } };
      expect(structured.item.title).toBe('Reachable over MCP');

      // The same call over HTTP, byte for byte the same payload.
      const overHttp = await app.inject({
        method: 'POST',
        url: '/v1/knowledge_get',
        headers: { authorization: `Bearer ${agentToken}` },
        payload: { item_id: item.item.id },
      });
      expect(overHttp.json()).toEqual(structured);
    } finally {
      await client.close();
    }
  });

  it('proposes through MCP, and the proposal is the one the inbox shows', async () => {
    const client = await connect(agentToken);
    try {
      const result = await client.callTool({
        name: 'knowledge_propose_create',
        arguments: {
          title: 'Proposed over MCP',
          body: 'An agent contributed this through the endpoint.',
          type: 'fact',
          reason: 'Learned while working.',
        },
      });
      expect(result.isError).toBeFalsy();
      const outcome = ProposalResult.parse(result.structuredContent);
      expect(outcome.proposal.status).toBe('pending');

      const inbox = (await admin.get('/v1/proposal.list?status=pending')).json() as {
        proposals: { id: string; title: string | null }[];
      };
      expect(inbox.proposals.find((p) => p.id === outcome.proposal.id)?.title).toBe(
        'Proposed over MCP',
      );
    } finally {
      await client.close();
    }
  });

  it('records what the call said about itself, not only what it did', async () => {
    const client = await connect(agentToken);
    try {
      const result = await client.callTool({
        name: 'knowledge_propose_create',
        arguments: {
          title: 'Proposed with provenance',
          body: 'The call named its client and its model.',
          type: 'fact',
        },
        // MCP_API.md section 4: a call says who is making it here, where the
        // same call over HTTP would use headers.
        _meta: {
          client: 'claude-code',
          provider: 'anthropic',
          model: 'claude-opus-5',
          session_id: 'conversation-7',
        },
      });
      expect(result.isError).toBeFalsy();
      const outcome = ProposalResult.parse(result.structuredContent);

      const workspace = (await services.repositories.workspaces.findBySlug('personal'))!;
      const events = await services.repositories.events.listAfter(workspace.id, 0, 500);
      const recorded = events.find((e) => e.objectId === outcome.proposal.id);
      // Rule 3: every material write records the client, the model and the
      // session when they are known, whichever transport brought them.
      expect(recorded).toMatchObject({
        client: 'claude-code',
        provider: 'anthropic',
        model: 'claude-opus-5',
        sessionId: 'ext:conversation-7',
      });
    } finally {
      await client.close();
    }
  });

  it('answers a refusal as a tool error carrying the code', async () => {
    const client = await connect(agentToken);
    try {
      const result = await client.callTool({
        name: 'knowledge_get',
        arguments: { item_id: 'kn_01J8Z2A0C1D2E3F4G5H6J7K8M9' },
      });
      // Not a transport failure: the call worked and the answer is no.
      expect(result.isError).toBe(true);
      const text = (result.content as { type: string; text: string }[])[0]!.text;
      expect(JSON.parse(text)).toMatchObject({ code: 'NOT_FOUND', retryable: false });
    } finally {
      await client.close();
    }
  });

  it('refuses a client with no credential', async () => {
    const client = new Client({ name: 'knoverge-test', version: 'test' });
    await expect(
      client.connect(
        new StreamableHTTPClientTransport(new URL('/mcp', baseUrl)) as unknown as Transport,
      ),
    ).rejects.toThrow();
  });

  it('tells a client that opens a stream that there is no session', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/mcp',
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(res.statusCode).toBe(405);
    expect(res.headers['allow']).toBe('POST');
  });
});

describe('the audit feed', () => {
  it('shows an agent only its own events, and the owner everything', async () => {
    const client = await connect(agentToken);
    try {
      const proposed = await client.callTool({
        name: 'knowledge_propose_create',
        arguments: { title: 'Audited', body: 'Made by the agent.', type: 'fact' },
      });
      expect(proposed.isError).toBeFalsy();

      const mine = await client.callTool({ name: 'events_list', arguments: {} });
      const feed = EventsListResponse.parse(mine.structuredContent);
      expect(feed.events.length).toBeGreaterThan(0);
      // events.read_own is what an agent holds: its own work and nobody's else.
      const actors = new Set(feed.events.map((e) => e.actor_id));
      expect(actors.size).toBe(1);
      expect(feed.events.every((e) => e.agent_id !== null)).toBe(true);
      // The cursor is the sequence, and asking again from it is empty.
      const after = await client.callTool({
        name: 'events_list',
        arguments: { after_sequence: feed.next_sequence },
      });
      expect(EventsListResponse.parse(after.structuredContent).events).toEqual([]);
    } finally {
      await client.close();
    }

    // The owner holds events.read_all and sees the workspace, not one actor.
    const all = EventsListResponse.parse(
      (await admin.post('/v1/events_list', { limit: 500 })).json(),
    );
    expect(new Set(all.events.map((e) => e.actor_id)).size).toBeGreaterThan(1);
    // Rule 4: ids, hashes and actor context, never the knowledge itself.
    expect(JSON.stringify(all.events)).not.toContain('Made by the agent.');
  });

  it('pages, and says when there is more', async () => {
    const page = EventsListResponse.parse(
      (await admin.post('/v1/events_list', { limit: 1, after_sequence: 0 })).json(),
    );
    expect(page.events).toHaveLength(1);
    expect(page.has_more).toBe(true);
    expect(page.next_sequence).toBe(page.events[0]!.sequence);
  });
});
