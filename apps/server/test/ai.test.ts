import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  ActivityDigestResponse,
  AiSettingsResponse,
  CheckAiProviderResponse,
  DraftSummaryResponse,
  TERMS_VERSION,
  TestAiGenerationResponse,
  TestAiModelResponse,
} from '@knoverge/contracts';
import { parseEncryptionKey } from '@knoverge/auth';
import { parseLedgerKey } from '@knoverge/core';
import { runMigrations } from '@knoverge/db';
import type { FastifyInstance, InjectOptions } from 'fastify';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.ts';
import { createServices, type Services } from '../src/services.ts';

const migrationsFolder = fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url));
const ok = { status: 'ok' as const };
/** What bge-m3 answers with, so the test says a real number. */
const DIMENSIONS = 1024;

let container: StartedPostgreSqlContainer;
let dataDir: string;
let services: Services;
let app: FastifyInstance;
let admin: Browser;
let ollama: Server;
let ollamaUrl: string;
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

/**
 * An Ollama, answering the three routes the product asks it for.
 *
 * A real server on a real socket rather than a stubbed `fetch`: what is being
 * tested is that the product's requests are ones an Ollama would recognise,
 * and a stub that answers whatever it is asked cannot say that.
 */
const authorizations: (string | undefined)[] = [];

function startOllama(): Promise<{ server: Server; url: string }> {
  const server = createServer((request, response) => {
    const url = request.url ?? '';
    // What a provider that wants a key would read. Recorded rather than
    // required, because most of these tests are an Ollama, which wants none.
    authorizations.push(request.headers.authorization);
    const send = (body: unknown) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (url === '/api/version') return send({ version: '0.32.13' });
    if (url === '/api/tags') {
      return send({
        models: [
          { name: 'bge-m3:latest', size: 594_000_000, capabilities: ['embedding'] },
          { name: 'gpt-oss:120b', size: 65_000_000_000, capabilities: ['completion', 'tools'] },
        ],
      });
    }
    if (url === '/api/embed' && request.method === 'POST') {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        const parsed = JSON.parse(body) as { model: string; input: string[] };
        if (!parsed.model.startsWith('bge-m3')) {
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: 'does not support embed' }));
          return;
        }
        send({
          embeddings: parsed.input.map((_, i) =>
            Array.from({ length: DIMENSIONS }, (_, d) => (i + d) / 10_000),
          ),
        });
      });
      return;
    }
    if (url === '/api/chat' && request.method === 'POST') {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        const parsed = JSON.parse(body) as {
          model: string;
          messages: { role: string; content: string }[];
        };
        // An embedding model asked to chat is what Ollama refuses, and the
        // point of being able to run a model before assigning it.
        if (parsed.model.startsWith('bge-m3')) {
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: 'does not support chat' }));
          return;
        }
        send({
          message: {
            role: 'assistant',
            // Quotes the instruction back, so a test can see the two arrived
            // as separate messages rather than concatenated into one.
            content: `${parsed.messages[0]?.role}:${parsed.messages[1]?.content ?? ''}`,
          },
          done_reason: 'stop',
          prompt_eval_count: 12,
          eval_count: 5,
        });
      });
      return;
    }
    response.writeHead(404).end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'knoverge-test-'));
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  const started = await startOllama();
  ollama = started.server;
  ollamaUrl = started.url;
  services = createServices({
    databaseUrl: container.getConnectionUri(),
    dataDir,
    ledgerKey: parseLedgerKey('a1'.repeat(32)),
    tokenPepper: 'b2'.repeat(32),
    encryptionKey: parseEncryptionKey('d4'.repeat(32)),
    poolMax: 4,
  });
  await runMigrations(services.database.db, migrationsFolder);
  app = await buildApp({
    loggerInstance: pino({ level: 'error' }),
    version: 'test',
    probes: { database: async () => ok, dataDir: async () => ok },
    services,
    security: { sessionSecret: 'c3'.repeat(32), cookieSecure: false },
  });
  admin = new Browser();
  admin.csrf = ((await admin.get('/v1/auth/csrf')).json() as { token: string }).token;
  expect(
    (
      await admin.post('/v1/bootstrap', {
        email: 'owner@example.com',
        password: 'correct horse battery staple',
        display_name: 'Owner',
        workspace: { slug: 'personal', name: 'Personal' },
        accepted_terms_version: TERMS_VERSION,
      })
    ).statusCode,
  ).toBe(200);
  const created = await admin.post('/v1/admin/agents.create', {
    name: 'A curious agent',
    trust_tier: 'trusted',
  });
  agentToken = (
    (
      await admin.post('/v1/admin/agents.credentials.issue', {
        agent_id: (created.json() as { agent: { id: string } }).agent.id,
      })
    ).json() as { token: string }
  ).token;
}, 180_000);

afterAll(async () => {
  ollama?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  await app?.close();
  await services?.close();
  await container?.stop();
});

describe('before anything is connected', () => {
  it('says nothing is, rather than nothing at all', async () => {
    const settings = AiSettingsResponse.parse((await admin.get('/v1/admin/ai.settings')).json());
    expect(settings.ai).toMatchObject({
      providers: [],
      assignments: [],
      embeddings_enabled: false,
    });
  });

  it('is not something an agent may see or change', async () => {
    // These are administration, not tools: no agent trust tier holds
    // workspace.admin, and an agent has no MCP name to reach them by.
    for (const url of ['/v1/admin/ai.settings']) {
      const res = await app.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${agentToken}` },
      });
      expect(res.statusCode, res.body).toBe(403);
    }
    const write = await app.inject({
      method: 'POST',
      url: '/v1/admin/ai.providers.save',
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { kind: 'ollama', name: 'Mine', base_url: 'http://ollama:11434' },
    });
    expect(write.statusCode, write.body).toBe(403);
  });

  it('refuses an address that is not http', async () => {
    // The server makes this request, so the scheme is not the caller's choice.
    const res = await admin.post('/v1/admin/ai.providers.check', {
      kind: 'ollama',
      base_url: 'file:///etc/passwd',
    });
    expect(res.statusCode, res.body).toBe(400);
  });
});

describe('the wizard, in the order somebody uses it', () => {
  it('reports an address that answers nothing as a finding, not a failure', async () => {
    const res = await admin.post('/v1/admin/ai.providers.check', {
      kind: 'ollama',
      // Port 1 on the loopback: nothing listens there, and nothing will.
      base_url: 'http://127.0.0.1:1',
    });
    expect(res.statusCode, res.body).toBe(200);
    const outcome = CheckAiProviderResponse.parse(res.json());
    expect(outcome.reachable).toBe(false);
    expect(outcome.error).toBeTruthy();
  });

  it('asks an address what it holds, before anything is saved', async () => {
    const res = await admin.post('/v1/admin/ai.providers.check', {
      kind: 'ollama',
      base_url: ollamaUrl,
    });
    const outcome = CheckAiProviderResponse.parse(res.json());
    expect(outcome.reachable).toBe(true);
    expect(outcome.version).toBe('0.32.13');
    expect(outcome.models.map((m) => m.name)).toContain('bge-m3:latest');
    // What the model is for, so a generative model is never offered as an
    // embedding model.
    expect(outcome.models.find((m) => m.name === 'bge-m3:latest')?.capabilities).toEqual([
      'embedding',
    ]);
    // Nothing was stored by asking.
    const settings = AiSettingsResponse.parse((await admin.get('/v1/admin/ai.settings')).json());
    expect(settings.ai.providers).toEqual([]);
  });

  it('runs a model before it is chosen, and says how many numbers came back', async () => {
    const res = await admin.post('/v1/admin/ai.test', {
      kind: 'ollama',
      base_url: ollamaUrl,
      model: 'bge-m3:latest',
    });
    const outcome = TestAiModelResponse.parse(res.json());
    expect(outcome.ok).toBe(true);
    expect(outcome.dimensions).toBe(DIMENSIONS);
    expect(outcome.latency_ms).not.toBeNull();
  });

  it('fails a model that cannot embed, which is what asking first is for', async () => {
    const res = await admin.post('/v1/admin/ai.test', {
      kind: 'ollama',
      base_url: ollamaUrl,
      model: 'gpt-oss:120b',
    });
    const outcome = TestAiModelResponse.parse(res.json());
    expect(outcome.ok).toBe(false);
    expect(outcome.dimensions).toBeNull();
    expect(outcome.error).toBeTruthy();
  });

  it('saves what worked, and turns it on', async () => {
    const saved = AiSettingsResponse.parse(
      (
        await admin.post('/v1/admin/ai.providers.save', {
          kind: 'ollama',
          name: 'The big machine',
          base_url: ollamaUrl,
        })
      ).json(),
    );
    const provider = saved.ai.providers[0];
    expect(provider).toMatchObject({ name: 'The big machine', origin: 'interface' });
    expect(saved.ai.embeddings_enabled).toBe(false);

    const assigned = AiSettingsResponse.parse(
      (
        await admin.post('/v1/admin/ai.assign', {
          purpose: 'embedding',
          provider_id: provider?.id,
          model: 'bge-m3:latest',
        })
      ).json(),
    );
    expect(assigned.ai.embeddings_enabled).toBe(true);
    expect(assigned.ai.assignments[0]?.model).toBe('bge-m3:latest');
  });

  it('runs a model that writes before it is chosen, and shows what it said', async () => {
    // The only proof a generation model works is reading one answer from it.
    // A dimension proves an embedding model; there is nothing equivalent here.
    const res = await admin.post('/v1/admin/ai.test_generation', {
      kind: 'ollama',
      base_url: ollamaUrl,
      model: 'gpt-oss:120b',
      text: 'The ledger only grows.',
    });
    expect(res.statusCode, res.body).toBe(200);
    const outcome = TestAiGenerationResponse.parse(res.json());
    expect(outcome.ok).toBe(true);
    expect(outcome.latency_ms).not.toBeNull();
    // The fake answers with the first message's role and the second message's
    // content, so this says the instruction and the material arrived apart.
    expect(outcome.text).toBe('system:The ledger only grows.');
  });

  it('fails a model that cannot write, which is what asking first is for', async () => {
    const res = await admin.post('/v1/admin/ai.test_generation', {
      kind: 'ollama',
      base_url: ollamaUrl,
      model: 'bge-m3:latest',
    });
    expect(res.statusCode, res.body).toBe(200);
    const outcome = TestAiGenerationResponse.parse(res.json());
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBeTruthy();
    // The provider's body may quote the prompt, and the prompt is knowledge.
    expect(outcome.error).not.toContain('does not support chat');
  });

  it('is not something an agent may run', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/ai.test_generation',
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { kind: 'ollama', base_url: ollamaUrl, model: 'gpt-oss:120b' },
    });
    expect([401, 403]).toContain(res.statusCode);
  });

  it('refuses a second provider at the same address', async () => {
    const res = await admin.post('/v1/admin/ai.providers.save', {
      kind: 'ollama',
      name: 'The same machine again',
      base_url: `${ollamaUrl}/`,
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
  });
});

describe('once a model is at work', () => {
  it('embeds knowledge without a restart, which is the point of configuring it here', async () => {
    // The provider was connected while this process was already running. A
    // wizard that needs a restart to take effect is not a wizard (ADR 0021).
    const created = await admin.post('/v1/admin/knowledge.create', {
      title: 'Passwordless login',
      body: 'Signing in uses a six-digit code sent by email, and Google OAuth.',
      type: 'decision',
    });
    expect(created.statusCode, created.body).toBe(200);

    const workspaces = await services.repositories.workspaces.list();
    const workspaceId = workspaces[0]?.id;
    expect(workspaceId).toBeTruthy();
    const report = await services.embeddings.fill(workspaceId as never);
    expect(report.embedded).toBeGreaterThan(0);

    const profile = await services.embeddings.activeProfile(workspaceId as never);
    expect(profile).toMatchObject({ model: 'bge-m3:latest', dimensions: DIMENSIONS });
  });

  it('drafts a summary from what the sources say now, and writes nothing', async () => {
    const settings = AiSettingsResponse.parse((await admin.get('/v1/admin/ai.settings')).json());
    const providerId = settings.ai.providers[0]?.id;
    expect(
      (
        await admin.post('/v1/admin/ai.assign', {
          purpose: 'generation',
          provider_id: providerId,
          model: 'gpt-oss:120b',
        })
      ).statusCode,
    ).toBe(200);

    const source = (
      await admin.post('/v1/admin/knowledge.create', {
        title: 'Retention is ninety days',
        body: 'Backups are kept for ninety days.',
        type: 'fact',
      })
    ).json() as { item: { id: string; current_revision_id: string } };

    const res = await admin.post('/v1/admin/knowledge.draft_summary', {
      item_ids: [source.item.id],
    });
    expect(res.statusCode, res.body).toBe(200);
    const draft = DraftSummaryResponse.parse(res.json());
    // The fake answers with the first message's role and the second message's
    // content, so this says the knowledge arrived as the material and not as
    // part of the instruction.
    expect(draft.body).toContain('Backups are kept for ninety days.');
    expect(draft.body.startsWith('system:')).toBe(true);
    expect(draft.model).toBe('gpt-oss:120b');
    // Ready to be sent straight back as `summary_of`, at the revision that was
    // read — which is what makes the summary that follows not stale.
    expect(draft.summary_of).toEqual([`${source.item.id}@${source.item.current_revision_id}`]);

    // Nothing was written. A path that generated knowledge and committed it in
    // one step would be a way for a model to put words nobody read in the
    // ledger.
    const listed = (await admin.get('/v1/knowledge.list?types=summary&limit=100')).json() as {
      items: unknown[];
    };
    expect(listed.items).toEqual([]);
  });

  it('describes a period in prose, from the tally and not from the knowledge', async () => {
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const res = await admin.post('/v1/activity_digest', { since, include_narrative: true });
    expect(res.statusCode, res.body).toBe(200);
    const digest = ActivityDigestResponse.parse(res.json());
    expect(digest.narrative?.model).toBe('gpt-oss:120b');
    // The fake echoes the first message's role and the second message's
    // content, so this says the tally arrived as the material — and that what
    // the model was given is a tally of titles and counts rather than the text
    // of the knowledge itself.
    expect(digest.narrative?.text).toContain('system:');
    expect(digest.narrative?.text).toContain('knowledge.created:');
    expect(digest.narrative?.text).not.toContain('Backups are kept for ninety days.');

    // And without asking, no call and no prose.
    const plain = ActivityDigestResponse.parse(
      (await admin.post('/v1/activity_digest', { since })).json(),
    );
    expect(plain.narrative).toBeNull();
    expect(plain.counts.length).toBeGreaterThan(0);
  });

  it('is not something an agent may ask for', async () => {
    // An agent has its own model, and rule 5 says its contribution arrives as a
    // proposal rather than through the server's.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/knowledge.draft_summary',
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { item_ids: ['kn_01M2ZZZZZZZZZZZZZZZZZZZZZZ'] },
    });
    expect([401, 403]).toContain(res.statusCode);
  });

  it('puts a second model to work without disturbing the first', async () => {
    // Two purposes, two assignments. Choosing what writes must not disturb
    // what measures, and both live at the same address here.
    const settings = AiSettingsResponse.parse((await admin.get('/v1/admin/ai.settings')).json());
    const providerId = settings.ai.providers[0]?.id;
    expect(providerId, 'the provider from the wizard test').toBeTruthy();

    const assigned = AiSettingsResponse.parse(
      (
        await admin.post('/v1/admin/ai.assign', {
          purpose: 'generation',
          provider_id: providerId,
          model: 'gpt-oss:120b',
        })
      ).json(),
    );
    expect(assigned.ai.generation_enabled).toBe(true);
    expect(assigned.ai.embeddings_enabled).toBe(true);
    expect(assigned.ai.assignments).toHaveLength(2);

    const stopped = AiSettingsResponse.parse(
      (await admin.post('/v1/admin/ai.unassign', { purpose: 'generation' })).json(),
    );
    expect(stopped.ai.generation_enabled).toBe(false);
    expect(stopped.ai.embeddings_enabled).toBe(true);
  });

  it('puts a model to work looking at pictures, which is a row of its own', async () => {
    const settings = AiSettingsResponse.parse((await admin.get('/v1/admin/ai.settings')).json());
    const providerId = settings.ai.providers[0]?.id;

    const assigned = AiSettingsResponse.parse(
      (
        await admin.post('/v1/admin/ai.assign', {
          purpose: 'vision',
          provider_id: providerId,
          model: 'gpt-oss:120b',
        })
      ).json(),
    );
    expect(assigned.ai.vision_enabled).toBe(true);
    expect(assigned.ai.assignments.find((a) => a.purpose === 'vision')?.model).toBe('gpt-oss:120b');

    const stopped = AiSettingsResponse.parse(
      (await admin.post('/v1/admin/ai.unassign', { purpose: 'vision' })).json(),
    );
    expect(stopped.ai.vision_enabled).toBe(false);
    expect(stopped.ai.embeddings_enabled).toBe(true);
  });

  it('refuses to put a model that cannot listen to work listening', async () => {
    const settings = AiSettingsResponse.parse((await admin.get('/v1/admin/ai.settings')).json());
    const providerId = settings.ai.providers[0]?.id;

    const refused = await admin.post('/v1/admin/ai.assign', {
      purpose: 'transcription',
      provider_id: providerId,
      model: 'gpt-oss:120b',
    });
    // Ollama has no endpoint that takes a recording. Stored and quietly never
    // used, this would be a settings page saying a model is listening while
    // nothing is — worse than no assignment at all.
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
    const after = AiSettingsResponse.parse((await admin.get('/v1/admin/ai.settings')).json());
    expect(after.ai.assignments.some((a) => a.purpose === 'transcription')).toBe(false);
    expect(after.ai.transcription_enabled).toBe(false);
  });

  it('stops reporting a listener when its provider is changed into one that cannot', async () => {
    const saved = AiSettingsResponse.parse(
      (
        await admin.post('/v1/admin/ai.providers.save', {
          kind: 'openai_compatible',
          name: 'The transcription box',
          base_url: 'http://whisper.invalid:8000',
        })
      ).json(),
    );
    const whisper = saved.ai.providers.find((p) => p.kind === 'openai_compatible');
    const assigned = AiSettingsResponse.parse(
      (
        await admin.post('/v1/admin/ai.assign', {
          purpose: 'transcription',
          provider_id: whisper?.id,
          model: 'whisper-1',
        })
      ).json(),
    );
    expect(assigned.ai.transcription_enabled).toBe(true);

    // The same row, made into an Ollama. The assignment survives the edit, and
    // an Ollama has no endpoint that takes a recording — so the page must stop
    // claiming anything is listening rather than keep the word from before.
    const changed = AiSettingsResponse.parse(
      (
        await admin.post('/v1/admin/ai.providers.save', {
          provider_id: whisper?.id,
          kind: 'ollama',
          name: 'The transcription box',
          base_url: 'http://whisper.invalid:8000',
        })
      ).json(),
    );
    expect(changed.ai.assignments.some((a) => a.purpose === 'transcription')).toBe(true);
    expect(changed.ai.transcription_enabled).toBe(false);

    // Removing it takes its assignment with it, so the tests after this one see
    // the installation the tests before it left.
    await admin.post('/v1/admin/ai.providers.remove', { provider_id: whisper?.id });
  });

  it('stops embedding when the provider is disconnected, and says so', async () => {
    const settings = AiSettingsResponse.parse((await admin.get('/v1/admin/ai.settings')).json());
    const providerId = settings.ai.providers[0]?.id;
    const after = AiSettingsResponse.parse(
      (await admin.post('/v1/admin/ai.providers.remove', { provider_id: providerId })).json(),
    );
    // The assignment goes with it: one pointing at nothing reads as
    // configured and embeds nothing.
    expect(after.ai.providers).toEqual([]);
    expect(after.ai.assignments).toEqual([]);
    expect(after.ai.embeddings_enabled).toBe(false);

    const workspaces = await services.repositories.workspaces.list();
    expect(await services.embeddings.fill(workspaces[0]?.id as never)).toEqual({
      embedded: 0,
      remaining: 0,
    });
  });

  it('sends a key to the provider that has one, and gives it back to nobody', async () => {
    // Before anything is saved: the wizard probes an address with the key
    // somebody just typed, because a form that can only test what is already
    // stored teaches people to store things that do not work (ADR 0021).
    authorizations.length = 0;
    await admin.post('/v1/admin/ai.providers.check', {
      kind: 'openai_compatible',
      base_url: ollamaUrl,
      api_key: 'sk-typed-not-yet-saved',
    });
    expect(authorizations).toContain('Bearer sk-typed-not-yet-saved');

    const saved = AiSettingsResponse.parse(
      (
        await admin.post('/v1/admin/ai.providers.save', {
          kind: 'openai_compatible',
          name: 'A gateway',
          base_url: ollamaUrl.replace('127.0.0.1', 'localhost'),
          api_key: 'sk-live-not-in-any-answer',
        })
      ).json(),
    );
    const gateway = saved.ai.providers.find((p) => p.name === 'A gateway');
    // Whether, never which. The key goes out to the provider and comes back to
    // nobody, so no screen, screenshot or support ticket can carry it.
    expect(gateway?.has_api_key).toBe(true);
    expect(JSON.stringify(saved)).not.toContain('sk-live-not-in-any-answer');
    expect(saved.ai.secret_storage_configured).toBe(true);

    // And it reaches the server it authorises: a probe carries it.
    authorizations.length = 0;
    await admin.post('/v1/admin/ai.providers.check', {
      kind: 'openai_compatible',
      base_url: gateway?.base_url,
    });
    expect(authorizations).toContain('Bearer sk-live-not-in-any-answer');

    const again = AiSettingsResponse.parse((await admin.get('/v1/admin/ai.settings')).json());
    expect(JSON.stringify(again)).not.toContain('sk-live-not-in-any-answer');
    await admin.post('/v1/admin/ai.providers.remove', { provider_id: gateway?.id });
  });

  it('still answers a search, because none of this was required', async () => {
    const res = await admin.post('/v1/knowledge_search', { query: 'passwordless login' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().results.length).toBeGreaterThan(0);
  });
});
