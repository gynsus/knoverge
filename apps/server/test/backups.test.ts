import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import type { BackupTools } from '@knoverge/backups';
import {
  BackupSettingsResponse,
  BackupsResponse,
  TERMS_VERSION,
  TakeBackupResponse,
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

let container: StartedPostgreSqlContainer;
let dataDir: string;
let backupDir: string;
let services: Services;
let app: FastifyInstance;
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

/**
 * A dump and an archive that write a few bytes.
 *
 * What is tested here is the surface — who may ask, what is stored, what comes
 * back — and a real `pg_dump` would make it depend on the version on the
 * machine running the tests. The command line's own suite dumps a real
 * database with the matching binary, which is where that belongs.
 */
const tools: BackupTools = {
  dump: (file) => writeFile(file, 'PGDMP', 'utf8'),
  archive: (file) => writeFile(file, 'gz', 'utf8'),
};

/**
 * An uploader that records what it was handed, and can be made to refuse.
 *
 * A real one would need an SSH server; the backup package tests against one in
 * its own suite, which is where the protocol belongs. What is tested here is
 * that the route and the job reach it with the opened credential and that the
 * pin comes back through the API.
 */
const uploads: { name: string; secret: string; knownHostFingerprint: string | null }[] = [];
let uploadFails: string | undefined;
/** What the far end presents. A rebuilt machine presents another one. */
let presents = 'SHA256:ZkCvW2';
const uploader = {
  upload: async (options: {
    name: string;
    secret: string;
    knownHostFingerprint: string | null;
  }) => {
    uploads.push({
      name: options.name,
      secret: options.secret,
      knownHostFingerprint: options.knownHostFingerprint,
    });
    if (uploadFails !== undefined) throw new Error(uploadFails);
    return { hostFingerprint: presents };
  },
};

const TARGET = {
  host: 'copies.example',
  port: 22,
  username: 'knoverge',
  directory: '/srv/knoverge',
  auth_kind: 'private_key' as const,
};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'knoverge-backup-data-'));
  backupDir = await mkdtemp(join(tmpdir(), 'knoverge-backup-out-'));
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  services = createServices({
    databaseUrl: container.getConnectionUri(),
    dataDir,
    backupDir,
    backupTools: tools,
    backupUploader: uploader,
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
  await app?.close();
  await services?.close();
  await container?.stop();
  for (const dir of [dataDir, backupDir])
    if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('an installation that has configured nothing', () => {
  it('says backups are off, rather than saying nothing', async () => {
    const body = BackupSettingsResponse.parse(
      (await admin.get('/v1/admin/backups.settings')).json(),
    );

    expect(body.settings).toMatchObject({
      enabled: false,
      interval_hours: 24,
      retention_days: 14,
      target: null,
      target_secret_set: false,
      secret_storage_configured: true,
      last_run_at: null,
    });
  });

  it('has no copies to list', async () => {
    const body = BackupsResponse.parse((await admin.get('/v1/admin/backups.list')).json());
    expect(body.backups).toEqual([]);
  });

  it('is not something an agent may see or change', async () => {
    // Administration, not tools: no agent trust tier holds workspace.admin and
    // an agent has no MCP name to reach these by (rule 11, ADR 0011).
    for (const url of ['/v1/admin/backups.settings', '/v1/admin/backups.list']) {
      const res = await app.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${agentToken}` },
      });
      expect(res.statusCode, res.body).toBe(403);
    }
    for (const url of [
      '/v1/admin/backups.save',
      '/v1/admin/backups.run',
      '/v1/admin/backups.clear_host_key',
    ]) {
      const res = await app.inject({
        method: 'POST',
        url,
        headers: { authorization: `Bearer ${agentToken}` },
        payload: { enabled: true },
      });
      expect(res.statusCode, res.body).toBe(403);
    }
  });
});

describe('turning them on', () => {
  it('keeps the schedule and the window, and still has no target', async () => {
    const body = BackupSettingsResponse.parse(
      (
        await admin.post('/v1/admin/backups.save', {
          enabled: true,
          interval_hours: 12,
          retention_days: 7,
        })
      ).json(),
    );

    expect(body.settings).toMatchObject({
      enabled: true,
      interval_hours: 12,
      retention_days: 7,
      target: null,
      target_secret_set: false,
    });
  });

  it('takes one when asked, and says what it wrote', async () => {
    const body = TakeBackupResponse.parse((await admin.post('/v1/admin/backups.run', {})).json());

    expect(body.ok, body.error ?? '').toBe(true);
    expect(body.name).toMatch(/^\d{8}T\d{6}Z$/u);
    expect(body.settings.last_run_at).not.toBeNull();
    expect(body.settings.last_error).toBeNull();
    expect((await readdir(join(backupDir, body.name as string))).sort()).toEqual([
      'data.tar.gz',
      'manifest.txt',
      'postgres.dump',
    ]);
  });

  it('lists it, and claims nothing about an upload nobody configured', async () => {
    const body = BackupsResponse.parse((await admin.get('/v1/admin/backups.list')).json());

    expect(body.backups).toHaveLength(1);
    expect(body.backups[0]?.size_bytes).toBeGreaterThan(0);
    expect(body.backups[0]?.uploaded).toBeNull();
  });
});

describe('a place to send them', () => {
  it('refuses a target with no credential to reach it', async () => {
    const res = await admin.post('/v1/admin/backups.save', {
      enabled: true,
      interval_hours: 12,
      retention_days: 7,
      target: TARGET,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('takes the credential once and never gives it back', async () => {
    const saved = BackupSettingsResponse.parse(
      (
        await admin.post('/v1/admin/backups.save', {
          enabled: true,
          interval_hours: 12,
          retention_days: 7,
          target: TARGET,
          target_secret: '-----BEGIN OPENSSH PRIVATE KEY-----',
        })
      ).json(),
    );

    expect(saved.settings.target).toEqual(TARGET);
    expect(saved.settings.target_secret_set).toBe(true);

    // Neither the key nor what it was sealed into. The sealed form is what a
    // leak would actually carry — the plaintext never reaches a response
    // object to begin with, so looking only for it is looking where it cannot
    // be. Read back out of the row, because only the database knows it.
    const stored = await services.database.db.execute<{ c: string }>(
      sql`SELECT "target_secret_ciphertext" AS c FROM "backup_settings"`,
    );
    const ciphertext = stored.rows[0]?.c ?? '';
    expect(ciphertext).not.toBe('');
    for (const body of [saved, await admin.get('/v1/admin/backups.settings')]) {
      const text = typeof body === 'object' && 'body' in body ? body.body : JSON.stringify(body);
      expect(text).not.toContain('BEGIN OPENSSH');
      expect(text).not.toContain(ciphertext);
    }
  });

  it('keeps it when only the port changes', async () => {
    const body = BackupSettingsResponse.parse(
      (
        await admin.post('/v1/admin/backups.save', {
          enabled: true,
          interval_hours: 12,
          retention_days: 7,
          target: { ...TARGET, port: 2222 },
        })
      ).json(),
    );

    expect(body.settings.target?.port).toBe(2222);
    expect(body.settings.target_secret_set).toBe(true);
  });

  it('removes it with the target', async () => {
    const body = BackupSettingsResponse.parse(
      (
        await admin.post('/v1/admin/backups.save', {
          enabled: false,
          interval_hours: 12,
          retention_days: 7,
          target: null,
        })
      ).json(),
    );

    expect(body.settings.target).toBeNull();
    expect(body.settings.target_secret_set).toBe(false);
  });
});

/**
 * Waits until the clock's second changes.
 *
 * A copy is named for the second it was taken in, so two runs inside one
 * second are the same copy and the second one is refused by name. These tests
 * drive the real clock through the API, so they have to let it move; it is
 * under a second each and does not depend on where in the second it starts.
 */
async function nextSecond(): Promise<void> {
  const second = Math.floor(Date.now() / 1000);
  while (Math.floor(Date.now() / 1000) === second) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('the copy that leaves the machine', () => {
  /** The whole target again, since the previous block removed it. */
  async function configure(secret?: string) {
    return BackupSettingsResponse.parse(
      (
        await admin.post('/v1/admin/backups.save', {
          enabled: true,
          interval_hours: 12,
          retention_days: 7,
          target: TARGET,
          ...(secret === undefined ? {} : { target_secret: secret }),
        })
      ).json(),
    );
  }

  it('has pinned nothing before anything has connected', async () => {
    const saved = await configure('-----BEGIN OPENSSH PRIVATE KEY-----');

    expect(saved.settings.target_host_fingerprint).toBeNull();
    expect(uploads).toEqual([]);
  });

  it('sends the copy with the opened credential, and pins what answered', async () => {
    await nextSecond();
    const report = TakeBackupResponse.parse((await admin.post('/v1/admin/backups.run', {})).json());

    expect(report.ok).toBe(true);
    expect(uploads).toEqual([
      {
        name: report.name,
        // Opened: the far machine cannot authenticate with ciphertext, and this
        // is the one place the plaintext is allowed to exist.
        secret: '-----BEGIN OPENSSH PRIVATE KEY-----',
        knownHostFingerprint: null,
      },
    ]);
    expect(report.settings.target_host_fingerprint).toBe('SHA256:ZkCvW2');
    expect(report.settings.last_upload_at).not.toBeNull();
    expect(report.settings.last_upload_error).toBeNull();
  });

  it('hands the pin over on the next run', async () => {
    await nextSecond();
    await admin.post('/v1/admin/backups.run', {});

    expect(uploads.at(-1)?.knownHostFingerprint).toBe('SHA256:ZkCvW2');
  });

  it('keeps the copy and reports the reason when the upload fails', async () => {
    uploadFails = 'the host key of copies.example changed';
    await nextSecond();
    try {
      const report = TakeBackupResponse.parse(
        (await admin.post('/v1/admin/backups.run', {})).json(),
      );

      // The run succeeded: a copy on this machine is a backup (ADR 0040). What
      // failed is the second copy, and it has its own two fields.
      expect(report.ok).toBe(true);
      expect(report.error).toBeNull();
      expect(report.name).not.toBeNull();
      expect(report.settings.last_error).toBeNull();
      expect(report.settings.last_upload_error).toBe('the host key of copies.example changed');
      expect(report.settings.last_upload_at).toBeNull();
      // And the pin survives, or one refused connection would become
      // permission for the next one.
      expect(report.settings.target_host_fingerprint).toBe('SHA256:ZkCvW2');
    } finally {
      uploadFails = undefined;
    }
  });

  it('says the copy is on this machine and not on the other one', async () => {
    const body = BackupsResponse.parse((await admin.get('/v1/admin/backups.list')).json());

    // The newest is the one whose upload just failed.
    expect(body.backups[0]?.uploaded).toBe(false);
  });

  it('forgets the pin when the operator names another machine', async () => {
    const body = BackupSettingsResponse.parse(
      (
        await admin.post('/v1/admin/backups.save', {
          enabled: true,
          interval_hours: 12,
          retention_days: 7,
          target: { ...TARGET, host: 'elsewhere.example' },
        })
      ).json(),
    );

    expect(body.settings.target_host_fingerprint).toBeNull();
    expect(body.settings.target_secret_set).toBe(true);
  });
});

/**
 * The case nothing else covers: the target machine was rebuilt.
 *
 * Its host, port, account and directory are all what the operator typed, so
 * saving the same settings leaves the pin where it is and every upload fails
 * (ADR 0041). This is the one action that says the next machine to answer is
 * the one they mean.
 */
describe('the machine that was rebuilt', () => {
  it('keeps the target and the credential, and forgets only the key', async () => {
    await admin.post('/v1/admin/backups.save', {
      enabled: true,
      interval_hours: 12,
      retention_days: 7,
      target: TARGET,
    });
    await nextSecond();
    const pinned = TakeBackupResponse.parse((await admin.post('/v1/admin/backups.run', {})).json());
    expect(pinned.settings.target_host_fingerprint).toBe('SHA256:ZkCvW2');

    const body = BackupSettingsResponse.parse(
      (await admin.post('/v1/admin/backups.clear_host_key', {})).json(),
    );

    expect(body.settings.target_host_fingerprint).toBeNull();
    // Only the key. Removing the target to clear the pin would mean finding
    // the private key again, which is why this is its own action.
    expect(body.settings.target).toMatchObject(TARGET);
    expect(body.settings.target_secret_set).toBe(true);
    expect(body.settings.interval_hours).toBe(12);
    expect(body.settings.retention_days).toBe(7);
  });

  it('lets the next run accept whatever answers, and pins that', async () => {
    presents = 'SHA256:therebuiltone';
    await nextSecond();

    const report = TakeBackupResponse.parse((await admin.post('/v1/admin/backups.run', {})).json());

    // Nothing pinned, so the upload accepts what it is given — once.
    expect(uploads.at(-1)?.knownHostFingerprint).toBeNull();
    expect(report.settings.target_host_fingerprint).toBe('SHA256:therebuiltone');
    expect(report.settings.last_upload_error).toBeNull();
  });

  it('is willing to forget nothing, so pressing it twice is not an error', async () => {
    await admin.post('/v1/admin/backups.clear_host_key', {});

    const body = BackupSettingsResponse.parse(
      (await admin.post('/v1/admin/backups.clear_host_key', {})).json(),
    );

    expect(body.settings.target_host_fingerprint).toBeNull();
  });
});
