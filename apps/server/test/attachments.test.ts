import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  AttachmentResponse,
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

/** Small, so the refusal is a test rather than a wait. */
const MAX_BYTES = 4096;

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
    expect(attachment.document_item_id).toBeNull();

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
