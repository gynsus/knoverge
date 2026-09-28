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
import { AttachmentExtractor, parseLedgerKey } from '@knoverge/core';
import { FileAttachmentStore, extractText } from '@knoverge/attachments';
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
    // Read from the item's side, because that is where the link is. Somebody
    // looking at a file wants the one question answered: what came out of it.
    expect(state.items.map((i) => i.id)).toEqual([mine!.itemId]);
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

  it('becomes a description when something here can look at a picture', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x11, 0x22]);
    const uploaded = AttachmentResponse.parse(
      (await admin.upload({ filename: 'whiteboard.png', type: 'image/png', body: png })).json(),
    );
    // Without a vision model this is where it stops, and the file is kept.
    const before = (await sweep()).find((o) => o.attachmentId === uploaded.attachment.id);
    expect(before?.state).toBe('unsupported');

    // With one, the same file becomes a document — and the extractor asks only
    // after the readers have said they cannot (rule 9).
    const described = new AttachmentExtractor({
      attachments: services.repositories.attachments,
      actors: services.repositories.actors,
      standingOf: async () => ({ role: 'owner' as const }),
      store: new FileAttachmentStore(dataDir),
      knowledge: services.knowledge,
      proposals: services.proposals,
      extract: extractText,
      describe: async () => ({
        text: 'A whiteboard with two boxes.\n\nText in the image:\nInput, Output',
        model: 'qwen2.5vl:7b',
      }),
      maxCharacters: 200_000,
    });
    const record = await services.repositories.attachments.findById(
      workspaceId,
      uploaded.attachment.id,
    );
    const outcome = await described.extract({ ...record!, extractionState: 'pending' });
    expect(outcome.state).toBe('extracted');

    const item = KnowledgeResponse.parse(
      (await admin.get(`/v1/knowledge.get?item_id=${outcome.itemId}`)).json(),
    ).item;
    expect(item.body).toContain('Text in the image:');
    // A description is a model's words about somebody's picture, and the file
    // says which model wrote them (ADR 0031).
    expect(item.drafted_by).toBe('qwen2.5vl:7b');
    expect(item.sources.find((s) => s.type === 'attachment')?.external_key).toBe(
      uploaded.attachment.id,
    );
  });

  it('becomes a transcript when something here can listen to a recording', async () => {
    const clip = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00]);
    const uploaded = AttachmentResponse.parse(
      (await admin.upload({ filename: 'standup.mp3', type: 'audio/mpeg', body: clip })).json(),
    );
    // Nothing here opens an MP3, so without a transcription model this is where
    // it stops, and the recording is kept and can be downloaded.
    const before = (await sweep()).find((o) => o.attachmentId === uploaded.attachment.id);
    expect(before?.state).toBe('unsupported');

    const heard: { mediaType: string; filename: string }[] = [];
    const looked: string[] = [];
    const listening = new AttachmentExtractor({
      attachments: services.repositories.attachments,
      actors: services.repositories.actors,
      standingOf: async () => ({ role: 'owner' as const }),
      store: new FileAttachmentStore(dataDir),
      knowledge: services.knowledge,
      proposals: services.proposals,
      extract: extractText,
      describe: async (mediaType) => {
        looked.push(mediaType);
        return null;
      },
      transcribe: async (mediaType, _bytes, filename) => {
        heard.push({ mediaType, filename });
        return { text: 'Support closes at five, every weekday.', model: 'whisper-1' };
      },
      maxCharacters: 200_000,
    });
    const record = await services.repositories.attachments.findById(
      workspaceId,
      uploaded.attachment.id,
    );
    const outcome = await listening.extract({ ...record!, extractionState: 'pending' });
    expect(outcome.state).toBe('extracted');

    const item = KnowledgeResponse.parse(
      (await admin.get(`/v1/knowledge.get?item_id=${outcome.itemId}`)).json(),
    ).item;
    expect(item.body).toContain('Support closes at five');
    // A transcript is a model's account of somebody's recording, so the item
    // says which model made it (ADR 0031).
    expect(item.drafted_by).toBe('whisper-1');
    expect(item.sources.find((s) => s.type === 'attachment')?.external_key).toBe(
      uploaded.attachment.id,
    );
    // Under its own name, because that is how a provider guesses the container.
    expect(heard).toEqual([{ mediaType: 'audio/mpeg', filename: 'standup.mp3' }]);
    // The describer was asked and said no, which is what makes the recording
    // reach the listener at all: one file, one answer, whichever gives it.
    expect(looked).toEqual(['audio/mpeg']);
  });

  it('asks one model or the other about a file, never both', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x33]);
    const uploaded = AttachmentResponse.parse(
      (await admin.upload({ filename: 'sketch.png', type: 'image/png', body: png })).json(),
    );
    const heard: string[] = [];
    const both = new AttachmentExtractor({
      attachments: services.repositories.attachments,
      actors: services.repositories.actors,
      standingOf: async () => ({ role: 'owner' as const }),
      store: new FileAttachmentStore(dataDir),
      knowledge: services.knowledge,
      proposals: services.proposals,
      extract: extractText,
      describe: async () => ({ text: 'A sketch of two boxes.', model: 'qwen2.5vl:7b' }),
      transcribe: async (mediaType) => {
        heard.push(mediaType);
        return { text: 'nobody said this', model: 'whisper-1' };
      },
      maxCharacters: 200_000,
    });
    const record = await services.repositories.attachments.findById(
      workspaceId,
      uploaded.attachment.id,
    );
    const outcome = await both.extract({ ...record!, extractionState: 'pending' });

    const item = KnowledgeResponse.parse(
      (await admin.get(`/v1/knowledge.get?item_id=${outcome.itemId}`)).json(),
    ).item;
    // One or the other, never both: a picture is looked at, and the recording
    // endpoint is never sent a PNG to be charged for and refuse.
    expect(item.body).toContain('A sketch of two boxes.');
    expect(item.drafted_by).toBe('qwen2.5vl:7b');
    expect(heard).toEqual([]);
  });

  it('reads a file again when something that could not read it now can', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x44]);
    const uploaded = AttachmentResponse.parse(
      (await admin.upload({ filename: 'March.png', type: 'image/png', body: png })).json(),
    );
    expect((await sweep()).find((o) => o.attachmentId === uploaded.attachment.id)?.state).toBe(
      'unsupported',
    );
    // A second sweep does nothing, which is the whole reason this exists: the
    // queue is files nobody has read yet, and this one has been read.
    expect((await sweep()).find((o) => o.attachmentId === uploaded.attachment.id)).toBeUndefined();

    const asked = await admin.post('/v1/admin/attachments.reread', {
      attachment_id: uploaded.attachment.id,
    });
    expect(asked.statusCode, asked.body).toBe(200);
    expect(asked.json()).toEqual({ queued: 1 });

    // Back in the queue, and with the model that could not be asked in March
    // now assigned, the same file becomes a document.
    const seeing = new AttachmentExtractor({
      attachments: services.repositories.attachments,
      actors: services.repositories.actors,
      standingOf: async () => ({ role: 'owner' as const }),
      store: new FileAttachmentStore(dataDir),
      knowledge: services.knowledge,
      proposals: services.proposals,
      extract: extractText,
      describe: async () => ({ text: 'A diagram of two boxes.', model: 'qwen2.5vl:7b' }),
      maxCharacters: 200_000,
    });
    const outcome = (await seeing.extractPending()).find(
      (o) => o.attachmentId === uploaded.attachment.id,
    );
    expect(outcome?.state).toBe('extracted');
    const item = KnowledgeResponse.parse(
      (await admin.get(`/v1/knowledge.get?item_id=${outcome!.itemId}`)).json(),
    ).item;
    expect(item.body).toContain('A diagram of two boxes.');
  });

  it('takes every file that was not read, for somebody who has just connected one', async () => {
    const before = AttachmentsResponse.parse(
      (await admin.get('/v1/admin/attachments.list')).json(),
    ).attachments.filter(
      (a) => a.extraction_state === 'unsupported' || a.extraction_state === 'failed',
    );

    const asked = await admin.post('/v1/admin/attachments.reread', {});
    expect(asked.statusCode, asked.body).toBe(200);
    // Somebody who assigns a model means every file it might now be able to
    // read, not the one they happen to be looking at.
    expect((asked.json() as { queued: number }).queued).toBe(before.length);
    expect(before.length).toBeGreaterThan(0);

    const after = AttachmentsResponse.parse(
      (await admin.get('/v1/admin/attachments.list')).json(),
    ).attachments;
    for (const file of before) {
      const now = after.find((a) => a.id === file.id);
      expect(now?.extraction_state).toBe('pending');
      // And the old reason goes with it: a file waiting to be read is not a
      // file carrying last month's error.
      expect(now?.extraction_error).toBeNull();
    }
  });

  it('refuses to read again a file that already became something', async () => {
    const uploaded = AttachmentResponse.parse(
      (
        await admin.upload({
          filename: 'already-read.md',
          type: 'text/markdown',
          body: '# Read\n\nThis one already became an item.\n',
        })
      ).json(),
    );
    await sweep();

    const refused = await admin.post('/v1/admin/attachments.reread', {
      attachment_id: uploaded.attachment.id,
    });
    // Reading it again would write a second document from the same file.
    // Answering zero would look like nothing happened; this says why.
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('never sends a file anything here can read to a model', async () => {
    const uploaded = AttachmentResponse.parse(
      (
        await admin.upload({
          filename: 'kept-at-home.md',
          type: 'text/markdown',
          body: '# Local\n\nThis never leaves the installation.\n',
        })
      ).json(),
    );
    const asked: string[] = [];
    const extractor = new AttachmentExtractor({
      attachments: services.repositories.attachments,
      actors: services.repositories.actors,
      standingOf: async () => ({ role: 'owner' as const }),
      store: new FileAttachmentStore(dataDir),
      knowledge: services.knowledge,
      proposals: services.proposals,
      extract: extractText,
      describe: async (mediaType) => {
        asked.push(mediaType);
        return { text: 'A model looked at a Markdown file.', model: 'qwen2.5vl:7b' };
      },
      maxCharacters: 200_000,
    });
    const record = await services.repositories.attachments.findById(
      workspaceId,
      uploaded.attachment.id,
    );
    const outcome = await extractor.extract({ ...record!, extractionState: 'pending' });

    expect(outcome.state).toBe('extracted');
    // Reading is free and looking is somebody else's GPU — and somebody else's
    // server. A file this installation can read itself is never sent anywhere
    // (rule 12).
    expect(asked).toEqual([]);
    const item = KnowledgeResponse.parse(
      (await admin.get(`/v1/knowledge.get?item_id=${outcome.itemId}`)).json(),
    ).item;
    expect(item.body).toContain('This never leaves the installation.');
    expect(item.drafted_by).toBeNull();
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

    // And nothing came out of the file yet, which is the honest answer while a
    // reviewer is holding the text.
    const held = SingleAttachmentResponse.parse(
      (await admin.get(`/v1/admin/attachments.get?attachment_id=${uploaded.attachment.id}`)).json(),
    );
    expect(held.items).toEqual([]);

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

describe('a file brought in by a tool', () => {
  const asAgent = (token: string, tool: string, payload: unknown) =>
    app.inject({
      method: 'POST',
      url: `/v1/${tool}`,
      headers: { authorization: `Bearer ${token}` },
      payload: payload as Record<string, unknown>,
    });

  it('arrives as base64 and lands where a multipart upload lands', async () => {
    const agent = await uploadingAgent('Tooling agent');
    const res = await asAgent(agent.token, 'attachment_upload', {
      filename: 'from-a-tool.md',
      media_type: 'text/markdown',
      content_base64: Buffer.from('# Read me\n\nBrought in by a tool.\n').toString('base64'),
      original_uri: 'https://example.com/read-me',
    });
    expect(res.statusCode, res.body).toBe(200);
    const { attachment, created } = AttachmentResponse.parse(res.json());
    expect(created).toBe(true);
    expect(attachment.filename).toBe('from-a-tool.md');

    // The same store and the same row a multipart upload produces: one service
    // under two shapes of request (rule 11).
    const path = join(
      dataDir,
      'attachments',
      workspaceId,
      attachment.content_hash.replace('sha256:', ''),
    );
    expect(await readFile(path, 'utf8')).toContain('Brought in by a tool.');

    const outcome = (await services.attachmentExtractor.extractPending()).find(
      (o) => o.attachmentId === attachment.id,
    );
    // And the text goes the way everything an agent writes goes.
    expect(outcome?.state).toBe('proposed');
  });

  it('refuses content that is not base64 rather than storing what survived', async () => {
    const agent = await uploadingAgent('Mangling agent');
    const res = await asAgent(agent.token, 'attachment_upload', {
      filename: 'mangled.txt',
      media_type: 'text/plain',
      // `Buffer.from` drops what it cannot read and returns the rest, which would
      // store a shorter file under the hash of something nobody sent.
      content_base64: 'this is not base64 !!!',
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('refuses a file past what this installation accepts', async () => {
    const agent = await uploadingAgent('Oversized agent');
    const res = await asAgent(agent.token, 'attachment_upload', {
      filename: 'big.bin',
      media_type: 'application/octet-stream',
      content_base64: Buffer.alloc(MAX_BYTES + 1, 3).toString('base64'),
    });
    // The domain's own limit, on the one path where nothing truncates first.
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('answers what became of a file, without a second call to find out', async () => {
    const agent = await uploadingAgent('Asking agent');
    const uploaded = AttachmentResponse.parse(
      (
        await asAgent(agent.token, 'attachment_upload', {
          filename: 'asked-about.txt',
          media_type: 'text/plain',
          content_base64: Buffer.from('What became of this file.\n').toString('base64'),
        })
      ).json(),
    );
    const listed = AttachmentsResponse.parse(
      (await asAgent(agent.token, 'attachment_list', {})).json(),
    );
    expect(listed.attachments.some((a) => a.id === uploaded.attachment.id)).toBe(true);

    const read = SingleAttachmentResponse.parse(
      (
        await asAgent(agent.token, 'attachment_get', { attachment_id: uploaded.attachment.id })
      ).json(),
    );
    // Nothing yet, and the state is what says why: the sweep has not run.
    expect(read.attachment.extraction_state).toBe('pending');
    expect(read.items).toEqual([]);
  });

  it('is refused to an agent that may only propose', async () => {
    const created = await admin.post('/v1/admin/agents.create', {
      name: 'Tooling proposer',
      trust_tier: 'propose',
    });
    expect(created.statusCode, created.body).toBe(200);
    const agentId = (created.json() as { agent: { id: string } }).agent.id;
    const issued = await admin.post('/v1/admin/agents.credentials.issue', { agent_id: agentId });
    const token = (issued.json() as { token: string }).token;

    const res = await asAgent(token, 'attachment_upload', {
      filename: 'not-allowed.txt',
      media_type: 'text/plain',
      content_base64: Buffer.from('Not allowed here.\n').toString('base64'),
    });
    // The permission is the same one the multipart route asks for, because it is
    // the same operation in a different shape (rule 11).
    expect(res.statusCode, res.body).toBe(403);
  });

  it('says how big a file may be, in the answer a client reads first', async () => {
    const agent = await uploadingAgent('Measuring agent');
    const manifest = (await asAgent(agent.token, 'workspace_manifest', {})).json() as {
      limits: { max_request_bytes: number; max_attachment_bytes: number };
    };
    // Base64 costs a third, and the rest of the call needs room: a client that
    // checked the request limit would send a file a third too large.
    expect(manifest.limits.max_attachment_bytes).toBeLessThan(manifest.limits.max_request_bytes);
    expect(manifest.limits.max_attachment_bytes).toBeLessThanOrEqual(MAX_BYTES);
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
