import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createBackupSettingsRepository,
  createDatabase,
  createUnitOfWork,
  runMigrations,
  type DatabaseHandle,
} from '../src/index.ts';

const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));

let container: StartedPostgreSqlContainer;
let handle: DatabaseHandle;
let uow: ReturnType<typeof createUnitOfWork>;
let settings: ReturnType<typeof createBackupSettingsRepository>;

const at = (minute: number) => new Date(Date.UTC(2026, 9, 9, 12, minute));

const target = {
  host: 'backups.example',
  port: 22,
  username: 'knoverge',
  directory: '/srv/backups/knoverge',
  authKind: 'private_key' as const,
};

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  handle = createDatabase({ connectionString: container.getConnectionUri(), max: 4 });
  handle.pool.on('error', () => undefined);
  await runMigrations(handle.db, migrationsFolder);
  uow = createUnitOfWork(handle.db);
  settings = createBackupSettingsRepository(handle.db);
});

afterAll(async () => {
  await handle?.close().catch(() => undefined);
  await container?.stop();
});

describe('the settings a fresh installation has', () => {
  it('exist, and say backups are off', async () => {
    // The migration inserts the row so the screen has something to read. An
    // installation that never thinks about backups still has none; what it
    // gains is being told so (ADR 0040).
    const s = await settings.get();
    expect(s.enabled).toBe(false);
    expect(s.target).toBeNull();
    expect(s.targetSecretCiphertext).toBeNull();
    expect(s.lastRunAt).toBeNull();
  });
});

describe('the one row', () => {
  it('cannot become two', async () => {
    // Without the CHECK this is a table that happens to hold one row, and
    // something eventually inserts a second — after which which schedule runs
    // is a question with two answers.
    await expect(
      handle.db.execute(sql`INSERT INTO backup_settings (id, updated_at) VALUES ('other', now())`),
    ).rejects.toThrow();
  });
});

/** A configured target with a secret, so each test below starts from one. */
async function store(secret: string): Promise<void> {
  await uow.run((tx) =>
    settings.save(
      tx,
      {
        enabled: true,
        intervalHours: 12,
        retentionDays: 30,
        target,
        targetSecretCiphertext: secret,
      },
      at(0),
    ),
  );
}

describe('a target', () => {
  it('is stored whole and read back whole', async () => {
    await uow.run((tx) =>
      settings.save(
        tx,
        {
          enabled: true,
          intervalHours: 12,
          retentionDays: 30,
          target,
          targetSecretCiphertext: 'sealed:abc',
        },
        at(1),
      ),
    );
    const s = await settings.get();
    expect(s).toMatchObject({ enabled: true, intervalHours: 12, retentionDays: 30 });
    expect(s.target).toEqual(target);
    expect(s.targetSecretCiphertext).toBe('sealed:abc');
  });

  it('cannot be stored in halves', async () => {
    // A host with no directory is a setting that looks configured and uploads
    // nowhere. The database refuses it rather than the form being the only
    // thing standing between an operator and that.
    await expect(
      handle.db.execute(
        sql`UPDATE backup_settings SET target_directory = NULL WHERE id = 'singleton'`,
      ),
    ).rejects.toThrow();
  });

  it('keeps its secret when something else about it changes', async () => {
    // Stored here rather than relying on the test above: a test that only
    // holds while its neighbours ran first passes on its own for the wrong
    // reason, which is how a test stops being able to fail.
    await store('sealed:port-change');

    // Changing a port should not mean retyping a private key.
    await uow.run((tx) =>
      settings.save(
        tx,
        { enabled: true, intervalHours: 12, retentionDays: 30, target: { ...target, port: 2222 } },
        at(2),
      ),
    );
    const s = await settings.get();
    expect(s.target?.port).toBe(2222);
    expect(s.targetSecretCiphertext).toBe('sealed:port-change');
  });

  it('takes its secret with it when it is removed', async () => {
    await store('sealed:to-be-removed');

    // A credential for a target that no longer exists is a credential kept for
    // no reason.
    await uow.run((tx) =>
      settings.save(
        tx,
        { enabled: false, intervalHours: 24, retentionDays: 14, target: null },
        at(3),
      ),
    );
    const s = await settings.get();
    expect(s.target).toBeNull();
    expect(s.targetSecretCiphertext).toBeNull();
  });

  it('can have its pinned host key cleared without losing anything else', async () => {
    await store('sealed:rebuilt-machine');
    await uow.run((tx) =>
      settings.recordRun(tx, {
        at: at(4),
        error: null,
        uploadedAt: at(4),
        uploadError: null,
        targetHostFingerprint: 'SHA256:theoldmachine',
      }),
    );

    await uow.run((tx) => settings.clearHostFingerprint(tx, at(5)));

    const s = await settings.get();
    expect(s.targetHostFingerprint).toBeNull();
    // One column. The target machine was rebuilt, and the address, the
    // credential, the schedule and the window are all still what the operator
    // chose — this is a decision about a key and nothing else.
    expect(s.target).toEqual(target);
    expect(s.targetSecretCiphertext).toBe('sealed:rebuilt-machine');
    expect(s.intervalHours).toBe(12);
    expect(s.retentionDays).toBe(30);
    expect(s.lastUploadAt).toEqual(at(4));
    expect(s.updatedAt).toEqual(at(5));
  });
});

describe('what a run leaves behind', () => {
  it('is recorded whether it worked or not, and does not touch the schedule', async () => {
    await uow.run((tx) =>
      settings.save(tx, { enabled: true, intervalHours: 6, retentionDays: 7, target: null }, at(4)),
    );
    await uow.run((tx) =>
      settings.recordRun(tx, {
        at: at(5),
        error: 'pg_dump exited 1',
        uploadedAt: null,
        uploadError: null,
      }),
    );
    const s = await settings.get();
    expect(s.lastRunAt).toEqual(at(5));
    expect(s.lastError).toBe('pg_dump exited 1');
    // A run reports; it does not reconfigure. The operator's settings are the
    // operator's.
    expect(s).toMatchObject({ enabled: true, intervalHours: 6, retentionDays: 7 });
  });

  it('records a failed upload separately from a failed backup', async () => {
    // The local copy was taken and is a backup. Conflating the two would make
    // an unreachable target look like no backup at all (ADR 0040).
    await uow.run((tx) =>
      settings.recordRun(tx, {
        at: at(6),
        error: null,
        uploadedAt: null,
        uploadError: 'connect ETIMEDOUT',
      }),
    );
    const s = await settings.get();
    expect(s.lastError).toBeNull();
    expect(s.lastUploadError).toBe('connect ETIMEDOUT');
  });
});

describe('the values the schedule allows', () => {
  it('are the ones the contract allows, because the two lists are one list', async () => {
    for (const bad of [
      sql`UPDATE backup_settings SET interval_hours = 0 WHERE id = 'singleton'`,
      sql`UPDATE backup_settings SET interval_hours = 169 WHERE id = 'singleton'`,
      sql`UPDATE backup_settings SET retention_days = 0 WHERE id = 'singleton'`,
      sql`UPDATE backup_settings SET retention_days = 366 WHERE id = 'singleton'`,
      sql`UPDATE backup_settings SET target_auth_kind = 'kerberos' WHERE id = 'singleton'`,
    ]) {
      await expect(handle.db.execute(bad)).rejects.toThrow();
    }
  });
});
