import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  AttachmentResponse,
  KnowledgeResponse,
  SingleAttachmentResponse,
  AttachmentsResponse,
  EventsListResponse,
  TERMS_VERSION,
  type WorkspaceId,
} from '@knoverge/contracts';
import { parseLedgerKey } from '@knoverge/core';
import { runMigrations } from '@knoverge/db';
import type { FastifyInstance, InjectOptions } from 'fastify';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.ts';
import { createServices, type Services } from '../src/services.ts';

const migrationsFolder = fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url));
const ok = { status: 'ok' as const };

/** Small, so the refusal is a test rather than a wait — and past the fixtures. */
const MAX_BYTES = 32_768;

let container: StartedPostgreSqlContainer;
let dataDir: string;
let services: Services;
let app: FastifyInstance;
let admin: Browser;
let workspaceId: WorkspaceId;

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

  /**
   * A file, as a browser sends one.
   *
   * Built by hand rather than with a library: the point of these tests is what
   * arrives over the wire, and a helper that builds the body the same way the
   * server reads it would agree with itself about a mistake.
   */
  upload(
    file: { filename: string; type: string; body: string | Buffer },
    fields: Record<string, string> = {},
  ) {
    const boundary = '----knovergeTest6f8a';
    const parts: Buffer[] = [];
    for (const [name, value] of Object.entries(fields)) {
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        ),
      );
    }
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\n` +
          `Content-Type: ${file.type}\r\n\r\n`,
      ),
      Buffer.isBuffer(file.body) ? file.body : Buffer.from(file.body),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    );
    return this.request({
      method: 'POST',
      url: '/v1/admin/attachments.upload',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat(parts),
    });
  }
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'knoverge-attachments-'));
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  services = createServices({
    databaseUrl: container.getConnectionUri(),
    dataDir,
    ledgerKey: parseLedgerKey('d4'.repeat(32)),
    tokenPepper: 'e5'.repeat(32),
    attachmentMaxBytes: MAX_BYTES,
    poolMax: 4,
  });
  await runMigrations(services.database.db, migrationsFolder);
  app = await buildApp({
    loggerInstance: pino({ level: 'error' }),
    version: 'test',
    probes: { database: async () => ok, dataDir: async () => ok },
    services,
    security: { sessionSecret: 'f6'.repeat(32), cookieSecure: false },
  });
  admin = new Browser();
  admin.csrf = ((await admin.get('/v1/auth/csrf')).json() as { token: string }).token;
  const bootstrapped = await admin.post('/v1/bootstrap', {
    email: 'owner@example.com',
    password: 'correct horse battery staple',
    display_name: 'Owner',
    workspace: { slug: 'personal', name: 'Personal' },
    accepted_terms_version: TERMS_VERSION,
  });
  expect(bootstrapped.statusCode, bootstrapped.body).toBe(200);
  workspaceId = (await services.repositories.workspaces.findBySlug('personal'))!.id;
});

afterAll(async () => {
  await app?.close();
  await services?.close();
  await container?.stop();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

describe('a file a workspace holds', () => {
  it('is kept under its own hash, beside the repositories', async () => {
    const res = await admin.upload({
      filename: 'support-hours.txt',
      type: 'text/plain',
      body: 'Until five, every weekday.\n',
    });
    expect(res.statusCode, res.body).toBe(200);
    const { attachment, created } = AttachmentResponse.parse(res.json());
    expect(created).toBe(true);
    expect(attachment.filename).toBe('support-hours.txt');
    expect(attachment.media_type).toBe('text/plain');
    expect(attachment.size_bytes).toBe(27);
    // Nothing has read it yet, and the row says so rather than guessing.
    expect(attachment.extraction_state).toBe('pending');

    // On disk where ADR 0008 says, which is what a reader with the data
    // directory and no application has to be able to find.
    const path = join(
      dataDir,
      'attachments',
      workspaceId,
      attachment.content_hash.replace('sha256:', ''),
    );
    expect(await readFile(path, 'utf8')).toBe('Until five, every weekday.\n');
  });

  it('is one attachment when the same bytes arrive twice', async () => {
    const body = 'The same file, sent from two machines.\n';
    const first = AttachmentResponse.parse(
      (await admin.upload({ filename: 'a.txt', type: 'text/plain', body })).json(),
    );
    const second = AttachmentResponse.parse(
      (await admin.upload({ filename: 'a-copy.txt', type: 'text/plain', body })).json(),
    );
    expect(second.attachment.id).toBe(first.attachment.id);
    // Said out loud: an uploader who expected a new id is told which one it is.
    expect(second.created).toBe(false);

    const listed = AttachmentsResponse.parse(
      (await admin.get('/v1/admin/attachments.list')).json(),
    );
    expect(
      listed.attachments.filter((a) => a.content_hash === first.attachment.content_hash),
    ).toHaveLength(1);
  });

  it('comes back as it went in, and never as a page', async () => {
    const uploaded = AttachmentResponse.parse(
      (
        await admin.upload({
          filename: 'notes.html',
          type: 'text/html',
          body: '<p>Written by somebody else.</p>',
        })
      ).json(),
    );
    const res = await admin.get(
      `/v1/admin/attachments.download?attachment_id=${uploaded.attachment.id}`,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('<p>Written by somebody else.</p>');
    // An uploaded page served inline would run on this installation's origin with
    // this installation's cookie, which is the reason knowledge is rendered and
    // never becomes HTML either.
    expect(res.headers['content-disposition']).toMatch(/^attachment;/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain('sandbox');
  });

  it('records that it arrived, and not what it was called', async () => {
    const uploaded = AttachmentResponse.parse(
      (
        await admin.upload({
          filename: 'salaries-2026.csv',
          type: 'text/csv',
          body: 'name,amount\n',
        })
      ).json(),
    );
    const feed = EventsListResponse.parse(
      (await admin.post('/v1/events_list', { limit: 50 })).json(),
    );
    const event = feed.events.find((e) => e.object_id === uploaded.attachment.id);
    expect(event?.event_type).toBe('attachment.uploaded');
    // A filename is the uploader's words and can say as much as the file does.
    // The ledger holds ids, hashes and safe metadata, and this is neither.
    expect(JSON.stringify(event)).not.toContain('salaries');
    expect(event?.metadata).toMatchObject({ media_type: 'text/csv', size_bytes: 12 });
  });

  it('refuses a file larger than this installation accepts', async () => {
    const res = await admin.upload({
      filename: 'big.bin',
      type: 'application/octet-stream',
      body: Buffer.alloc(MAX_BYTES + 1, 7),
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('keeps no path in what a file is called', async () => {
    // What a file is called is written into a header on the way out and shown in
    // an interface; it is never where the file is kept, which is its hash. The
    // parser takes the directory off, the domain refuses one that gets past it,
    // and either way nothing with a separator in it is stored.
    const res = await admin.upload({
      filename: '../../etc/passwd',
      type: 'text/plain',
      body: 'root:x:0:0\n',
    });
    expect(res.statusCode, res.body).toBe(200);
    const { attachment } = AttachmentResponse.parse(res.json());
    expect(attachment.filename).toBe('passwd');
    expect(attachment.filename).not.toMatch(/[/\\]/u);
  });

  it('refuses an empty file', async () => {
    const res = await admin.upload({ filename: 'empty.txt', type: 'text/plain', body: '' });
    expect(res.statusCode, res.body).toBe(400);
  });

  it('answers NOT_FOUND for an attachment this workspace does not hold', async () => {
    const res = await admin.get(
      '/v1/admin/attachments.get?attachment_id=att_01J8Z3M4Q9V0X7K2B5N6P8R1T3',
    );
    expect(res.statusCode).toBe(404);
  });
});

/** An agent that may write knowledge, which is what putting a file here takes. */
async function uploadingAgent(name: string): Promise<{ token: string; actorId: string }> {
  const created = await admin.post('/v1/admin/agents.create', { name, trust_tier: 'trusted' });
  expect(created.statusCode, created.body).toBe(200);
  const agent = (created.json() as { agent: { id: string; actor_id: string } }).agent;
  const issued = await admin.post('/v1/admin/agents.credentials.issue', { agent_id: agent.id });
  expect(issued.statusCode, issued.body).toBe(200);
  return { token: (issued.json() as { token: string }).token, actorId: agent.actor_id };
}

describe('the text inside a file', () => {
  /** The sweep, run on demand rather than waited for. */
  const sweep = () => services.attachmentExtractor.extractPending();

  it('becomes a document with a source that says which file it was', async () => {
    const uploaded = AttachmentResponse.parse(
      (
        await admin.upload(
          {
            filename: 'escalation-path.md',
            type: 'text/markdown',
            body: '# Escalation\n\nSupport, then the on-call engineer.\n',
          },
          { original_uri: 'https://intranet.example.com/escalation' },
        )
      ).json(),
    );
    const outcomes = await sweep();
    const mine = outcomes.find((o) => o.attachmentId === uploaded.attachment.id);
    expect(mine?.state).toBe('extracted');

    const item = KnowledgeResponse.parse(
      (await admin.get(`/v1/knowledge.get?item_id=${mine!.itemId}`)).json(),
    ).item;
    // The filename without its extension: a title is the field a reader scans,
    // and it is what somebody called the thing.
    expect(item.title).toBe('escalation-path');
    expect(item.type).toBe('document');
    expect(item.body).toContain('Support, then the on-call engineer.');
    // The link between the file and what came out of it, in the item and in the
    // file on disk: which attachment, and which bytes it was read from.
    const source = item.sources.find((s) => s.type === 'attachment');
    expect(source?.external_key).toBe(uploaded.attachment.id);
    expect(source?.content_hash).toBe(uploaded.attachment.content_hash);
    expect(source?.uri).toBe('https://intranet.example.com/escalation');

    const state = SingleAttachmentResponse.parse(
      (await admin.get(`/v1/admin/attachments.get?attachment_id=${uploaded.attachment.id}`)).json(),
    );
    expect(state.attachment.extraction_state).toBe('extracted');
  });

  it('is read once, not on every sweep', async () => {
    const uploaded = AttachmentResponse.parse(
      (
        await admin.upload({
          filename: 'read-once.txt',
          type: 'text/plain',
          body: 'Read this once.\n',
        })
      ).json(),
    );
    await sweep();
    const second = await sweep();
    // Nothing pending means nothing to do: a sweep that re-read what it had
    // already read would make a second document every minute.
    expect(second.some((o) => o.attachmentId === uploaded.attachment.id)).toBe(false);
  });

  it('is read by one worker even when two sweep at once', async () => {
    const uploaded = AttachmentResponse.parse(
      (
        await admin.upload({
          filename: 'two-workers.txt',
          type: 'text/plain',
          body: 'Two workers, one document.\n',
        })
      ).json(),
    );
    // A second container with KNOVERGE_ROLE=worker is a documented deployment, and
    // extraction is not idempotent: two workers reading one file would write the
    // same document twice. The claim is what stops it, so the claim is what this
    // asks about — one statement moves the row out of reach of the second worker.
    const stale = new Date(Date.now() - 60 * 60_000);
    const claimed = await services.repositories.attachments.claimUnread(10, stale, new Date());
    expect(claimed.map((a) => a.id)).toContain(uploaded.attachment.id);
    expect(claimed.find((a) => a.id === uploaded.attachment.id)?.extractionState).toBe(
      'extracting',
    );

    const second = await services.repositories.attachments.claimUnread(10, stale, new Date());
    expect(second.map((a) => a.id)).not.toContain(uploaded.attachment.id);

    // And the file still gets read: the worker holding it finishes, and what it
    // wrote is one document.
    const outcome = await services.attachmentExtractor.extract(
      claimed.find((a) => a.id === uploaded.attachment.id)!,
    );
    expect(outcome.state).toBe('extracted');
    const found = (
      await admin.post('/v1/knowledge_search', { query: 'Two workers, one document', limit: 10 })
    ).json() as { results: { title: string }[] };
    expect(found.results.filter((r) => r.title === 'two-workers')).toHaveLength(1);
  });

  it('reads a PDF, end to end', async () => {
    const pdf = await readFile(
      new URL('../../../packages/attachments/test/fixtures/runbook.pdf', import.meta.url),
    );
    const uploaded = AttachmentResponse.parse(
      (await admin.upload({ filename: 'runbook.pdf', type: 'application/pdf', body: pdf })).json(),
    );
    const outcome = (await sweep()).find((o) => o.attachmentId === uploaded.attachment.id);
    expect(outcome?.state, JSON.stringify(outcome)).toBe('extracted');

    const item = KnowledgeResponse.parse(
      (await admin.get(`/v1/knowledge.get?item_id=${outcome!.itemId}`)).json(),
    ).item;
    expect(item.body).toContain('one application container and PostgreSQL');
  });

  it('says a type it cannot read is a type it cannot read', async () => {
    const uploaded = AttachmentResponse.parse(
      (
        await admin.upload({
          filename: 'diagram.png',
          type: 'image/png',
          body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        })
      ).json(),
    );
    const outcome = (await sweep()).find((o) => o.attachmentId === uploaded.attachment.id);
    // Not a failure. The file is kept and can be downloaded; a later milestone
    // teaches this to read it (ADR 0008).
    expect(outcome?.state).toBe('unsupported');
    expect(outcome?.itemId).toBeNull();
  });

  it('waits for a reviewer when an agent brought the file', async () => {
    const agent = await uploadingAgent('Filing agent');
    const boundary = '----knovergeAgentFile';
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="agent-notes.txt"\r\n` +
          'Content-Type: text/plain\r\n\r\n',
      ),
      Buffer.from('What the agent read somewhere, in its own words.\n'),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/attachments.upload',
      headers: {
        authorization: `Bearer ${agent.token}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });
    expect(res.statusCode, res.body).toBe(200);
    const uploaded = AttachmentResponse.parse(res.json());

    const outcome = (await sweep()).find((o) => o.attachmentId === uploaded.attachment.id);
    // A file is not a way past rule 5: the document goes to the review queue
    // exactly as anything else the agent writes does.
    expect(outcome?.state).toBe('proposed');
    expect(outcome?.itemId).toBeNull();

    const proposals = (await admin.get('/v1/proposal.list?status=pending')).json() as {
      proposals: { title: string; proposed_by_actor_id: string }[];
    };
    const waiting = proposals.proposals.find((p) => p.title === 'agent-notes');
    expect(waiting).toBeDefined();
    // Proposed by the agent that brought the file, not by the server and not by
    // whoever happens to be reviewing: the one write in this product that cannot
    // be traced to somebody would be this one (rule 3).
    expect(waiting?.proposed_by_actor_id).toBe(agent.actorId);
  });
});

describe('who may bring a file in', () => {
  async function agentToken(tier: string, name: string) {
    const created = await admin.post('/v1/admin/agents.create', { name, trust_tier: tier });
    expect(created.statusCode, created.body).toBe(200);
    const agentId = (created.json() as { agent: { id: string } }).agent.id;
    const issued = await admin.post('/v1/admin/agents.credentials.issue', { agent_id: agentId });
    expect(issued.statusCode, issued.body).toBe(200);
    return (issued.json() as { token: string }).token;
  }

  it('is whoever may write knowledge, and nobody else', async () => {
    const token = await agentToken('propose', 'Proposing agent');
    const boundary = '----knovergeAgent';
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="from-agent.txt"\r\n` +
          'Content-Type: text/plain\r\n\r\n',
      ),
      Buffer.from('An agent tried to put a file here.\n'),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/attachments.upload',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });
    // An agent that may only propose may not put a file here: `knowledge.write`
    // is the permission, and the default three do not include it (rule 5).
    //
    // An agent that does hold it may, and that is not a hole: a file is not
    // knowledge. What the file *says* becomes a `document` item, and that write
    // meets the policy like any other — which is the step the extraction job has
    // to get right.
    expect(res.statusCode, res.body).toBe(403);
  });
});
