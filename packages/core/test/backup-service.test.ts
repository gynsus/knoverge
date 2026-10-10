import { describe, expect, it } from 'vitest';

import {
  BackupService,
  DomainError,
  type BackupSettingsRecord,
  type BackupSettingsRepository,
  type BackupStore,
  type BackupTargetRecord,
  type BackupUploader,
  type StoredBackupInfo,
  type Tx,
  type UnitOfWork,
} from '../src/index.ts';

/** The row the migration creates: an installation that has configured nothing. */
function fresh(): BackupSettingsRecord {
  return {
    enabled: false,
    intervalHours: 24,
    retentionDays: 14,
    target: null,
    targetSecretCiphertext: null,
    targetHostFingerprint: null,
    lastRunAt: null,
    lastError: null,
    lastUploadAt: null,
    lastUploadError: null,
    updatedAt: new Date('2026-10-01T00:00:00Z'),
  };
}

/** The one row, in memory, because this is about the service's decisions. */
function settings(initial: BackupSettingsRecord = fresh()): BackupSettingsRepository & {
  row: () => BackupSettingsRecord;
} {
  let row = initial;
  return {
    row: () => row,
    get: async () => row,
    save: async (_tx, patch, at) => {
      row = {
        ...row,
        enabled: patch.enabled,
        intervalHours: patch.intervalHours,
        retentionDays: patch.retentionDays,
        target: patch.target,
        ...(patch.targetSecretCiphertext === undefined
          ? {}
          : { targetSecretCiphertext: patch.targetSecretCiphertext }),
        ...(patch.targetHostFingerprint === undefined
          ? {}
          : { targetHostFingerprint: patch.targetHostFingerprint }),
        updatedAt: at,
      };
    },
    recordRun: async (_tx, outcome) => {
      row = {
        ...row,
        lastRunAt: outcome.at,
        lastError: outcome.error,
        lastUploadAt: outcome.uploadedAt,
        lastUploadError: outcome.uploadError,
        ...(outcome.targetHostFingerprint === undefined
          ? {}
          : { targetHostFingerprint: outcome.targetHostFingerprint }),
      };
    },
  };
}

/**
 * No transaction, because the repository above is a variable.
 *
 * What the service asks of it is that the write happens inside one, and that is
 * the database's test to fail, not this one's.
 */
const uow: UnitOfWork = {
  run: async <T>(fn: (tx: Tx) => Promise<T>) => fn(undefined as unknown as Tx),
  runExclusive: async <T>(_key: string, fn: (tx: Tx) => Promise<T>) =>
    fn(undefined as unknown as Tx),
  withWorkspaceLock: async <T>(_workspaceId: string, fn: () => Promise<T>) => fn(),
};

/** A store that remembers what it was asked for, and can be made to fail. */
function store(options?: { fail?: string; have?: StoredBackupInfo[] }): BackupStore & {
  asked: { retentionDays: number; now: Date }[];
} {
  const asked: { retentionDays: number; now: Date }[] = [];
  return {
    asked,
    take: async (input) => {
      asked.push(input);
      if (options?.fail) throw new Error(options.fail);
      return { name: '20261010T090000Z', path: `/backups/20261010T090000Z`, removed: ['old'] };
    },
    list: async () => options?.have ?? [],
  };
}

const secrets = {
  seal: (plaintext: string) => `sealed(${plaintext})`,
  open: (sealed: string) => sealed.replace(/^sealed\(|\)$/gu, ''),
};

/** An uploader that remembers what it was handed, and can be made to refuse. */
function uploader(options?: { fail?: string; presents?: string }): BackupUploader & {
  asked: Parameters<BackupUploader['upload']>[0][];
} {
  const asked: Parameters<BackupUploader['upload']>[0][] = [];
  return {
    asked,
    upload: async (input) => {
      asked.push(input);
      if (options?.fail) throw new Error(options.fail);
      return { hostFingerprint: options?.presents ?? 'SHA256:abc' };
    },
  };
}

const TARGET: BackupTargetRecord = {
  host: 'backup.example',
  port: 22,
  username: 'knoverge',
  directory: '/srv/copies',
  authKind: 'private_key',
};

function at(iso: string) {
  return { now: () => new Date(iso) };
}

describe('backup settings', () => {
  it('reads as off on an installation that has configured nothing', async () => {
    const service = new BackupService({ uow, settings: settings(), store: store(), secrets });

    const view = await service.settings();

    expect(view.enabled).toBe(false);
    expect(view.target).toBeNull();
    expect(view.targetSecretSet).toBe(false);
    expect(view.secretStorageConfigured).toBe(true);
  });

  it('says a target cannot be kept at all without an encryption key', async () => {
    const service = new BackupService({ uow, settings: settings(), store: store() });

    expect((await service.settings()).secretStorageConfigured).toBe(false);
    await expect(
      service.save({
        enabled: true,
        intervalHours: 24,
        retentionDays: 14,
        target: TARGET,
        targetSecret: 'a key',
      }),
    ).rejects.toThrow(/KNOVERGE_ENCRYPTION_KEY/u);
  });

  it('turns backups on without a target at all', async () => {
    const rows = settings();
    const service = new BackupService({ uow, settings: rows, store: store(), secrets });

    const view = await service.save({
      enabled: true,
      intervalHours: 6,
      retentionDays: 30,
      target: null,
    });

    expect(view).toMatchObject({ enabled: true, intervalHours: 6, retentionDays: 30 });
    expect(rows.row().targetSecretCiphertext).toBeNull();
  });

  it('seals the credential and never hands it back', async () => {
    const rows = settings();
    const service = new BackupService({ uow, settings: rows, store: store(), secrets });

    const view = await service.save({
      enabled: true,
      intervalHours: 24,
      retentionDays: 14,
      target: TARGET,
      targetSecret: 'the private key',
    });

    expect(rows.row().targetSecretCiphertext).toBe('sealed(the private key)');
    expect(view.targetSecretSet).toBe(true);
    // Neither the key nor the sealed form of it: the view is what a screen is
    // handed, and a screen has no use for either.
    expect(JSON.stringify(view)).not.toContain('the private key');
    expect(JSON.stringify(view)).not.toContain('sealed(');
  });

  it('keeps the stored credential when only the port changed', async () => {
    const rows = settings();
    const service = new BackupService({ uow, settings: rows, store: store(), secrets });
    await service.save({
      enabled: true,
      intervalHours: 24,
      retentionDays: 14,
      target: TARGET,
      targetSecret: 'the private key',
    });

    const view = await service.save({
      enabled: true,
      intervalHours: 24,
      retentionDays: 14,
      target: { ...TARGET, port: 2222 },
    });

    expect(view.target?.port).toBe(2222);
    expect(rows.row().targetSecretCiphertext).toBe('sealed(the private key)');
  });

  it('refuses to keep a key while the form now asks for a password', async () => {
    const rows = settings();
    const service = new BackupService({ uow, settings: rows, store: store(), secrets });
    await service.save({
      enabled: true,
      intervalHours: 24,
      retentionDays: 14,
      target: TARGET,
      targetSecret: 'the private key',
    });

    // A target that authenticates with something nobody chose is worse than a
    // form that asks again.
    await expect(
      service.save({
        enabled: true,
        intervalHours: 24,
        retentionDays: 14,
        target: { ...TARGET, authKind: 'password' },
      }),
    ).rejects.toThrow(/give the password/u);
    expect(rows.row().target?.authKind).toBe('private_key');
  });

  it('removes the credential with the target', async () => {
    const rows = settings();
    const service = new BackupService({ uow, settings: rows, store: store(), secrets });
    await service.save({
      enabled: true,
      intervalHours: 24,
      retentionDays: 14,
      target: TARGET,
      targetSecret: 'the private key',
    });

    const view = await service.save({
      enabled: true,
      intervalHours: 24,
      retentionDays: 14,
      target: null,
    });

    expect(view.target).toBeNull();
    expect(view.targetSecretSet).toBe(false);
    expect(rows.row().targetSecretCiphertext).toBeNull();
  });

  it('refuses a directory that is not absolute on the far machine', async () => {
    const service = new BackupService({ uow, settings: settings(), store: store(), secrets });

    await expect(
      service.save({
        enabled: true,
        intervalHours: 24,
        retentionDays: 14,
        target: { ...TARGET, directory: 'copies/knoverge' },
        targetSecret: 'a key',
      }),
    ).rejects.toThrow(DomainError);
  });
});

describe('taking one', () => {
  it('records the run and passes the window the operator chose', async () => {
    const rows = settings({ ...fresh(), enabled: true, retentionDays: 30 });
    const shelf = store();
    const service = new BackupService({
      uow,
      settings: rows,
      store: shelf,
      secrets,
      clock: at('2026-10-10T09:00:00Z'),
    });

    const report = await service.run();

    expect(report).toMatchObject({ ok: true, name: '20261010T090000Z', removed: ['old'] });
    expect(shelf.asked).toEqual([{ retentionDays: 30, now: new Date('2026-10-10T09:00:00Z') }]);
    expect(rows.row().lastRunAt).toEqual(new Date('2026-10-10T09:00:00Z'));
    expect(rows.row().lastError).toBeNull();
  });

  it('records a failure instead of throwing it at the worker', async () => {
    const rows = settings({ ...fresh(), enabled: true });
    const service = new BackupService({
      uow,
      settings: rows,
      store: store({ fail: 'pg_dump: connection refused\n  at nothing' }),
      secrets,
      clock: at('2026-10-10T09:00:00Z'),
    });

    const report = await service.run();

    expect(report.ok).toBe(false);
    // One line, because it goes on a screen beside the setting.
    expect(report.error).toBe('pg_dump: connection refused at nothing');
    expect(rows.row().lastRunAt).toEqual(new Date('2026-10-10T09:00:00Z'));
    expect(rows.row().lastError).toBe('pg_dump: connection refused at nothing');
  });
});

describe('whether it is time', () => {
  it('does nothing while backups are off', async () => {
    const shelf = store();
    const service = new BackupService({
      uow,
      settings: settings(),
      store: shelf,
      secrets,
      clock: at('2026-10-10T09:00:00Z'),
    });

    expect(await service.runIfDue()).toEqual({ ran: false, reason: 'backups are off' });
    expect(shelf.asked).toEqual([]);
  });

  it('takes the first one at the first tick after it is turned on', async () => {
    const shelf = store();
    const service = new BackupService({
      uow,
      settings: settings({ ...fresh(), enabled: true }),
      store: shelf,
      secrets,
      clock: at('2026-10-10T09:00:00Z'),
    });

    // Never run, so there is no interval to wait out from a moment nobody chose.
    expect(await service.runIfDue()).toMatchObject({ ran: true });
    expect(shelf.asked).toHaveLength(1);
  });

  it('says no until the interval has passed, and yes once it has', async () => {
    const row = {
      ...fresh(),
      enabled: true,
      intervalHours: 12,
      lastRunAt: new Date('2026-10-10T00:00:00Z'),
    };
    const shelf = store();
    const early = new BackupService({
      uow,
      settings: settings(row),
      store: shelf,
      secrets,
      clock: at('2026-10-10T11:59:00Z'),
    });
    const late = new BackupService({
      uow,
      settings: settings(row),
      store: shelf,
      secrets,
      clock: at('2026-10-10T12:00:00Z'),
    });

    expect(await early.runIfDue()).toEqual({ ran: false, reason: 'not due yet' });
    expect(await late.runIfDue()).toMatchObject({ ran: true });
    expect(shelf.asked).toHaveLength(1);
  });
});

describe('what is on disk', () => {
  const copies: StoredBackupInfo[] = [
    { name: '20261010T090000Z', takenAt: new Date('2026-10-10T09:00:00Z'), sizeBytes: 90 },
    { name: '20261009T090000Z', takenAt: new Date('2026-10-09T09:00:00Z'), sizeBytes: 80 },
  ];

  it('claims nothing about an upload when there is no target', async () => {
    const service = new BackupService({
      uow,
      settings: settings({ ...fresh(), lastRunAt: new Date('2026-10-10T09:00:00Z') }),
      store: store({ have: copies }),
      secrets,
    });

    expect((await service.backups()).map((b) => b.uploaded)).toEqual([null, null]);
  });

  it('speaks only for the copy the last run produced', async () => {
    const service = new BackupService({
      uow,
      settings: settings({
        ...fresh(),
        target: TARGET,
        targetSecretCiphertext: 'sealed(k)',
        // With milliseconds, as a real run has them: a copy's name is only
        // accurate to the second, and comparing them whole would match almost
        // never and report every copy as unknown.
        lastRunAt: new Date('2026-10-10T09:00:00.412Z'),
        lastUploadError: 'connection refused',
      }),
      store: store({ have: copies }),
      secrets,
    });

    // The older one was taken before this target existed, and nothing records
    // what happened to it.
    expect((await service.backups()).map((b) => b.uploaded)).toEqual([false, null]);
  });
});

describe('sending it somewhere else', () => {
  /** An installation with a target configured and a credential stored. */
  function configured(extra: Partial<BackupSettingsRecord> = {}): BackupSettingsRecord {
    return {
      ...fresh(),
      enabled: true,
      target: TARGET,
      targetSecretCiphertext: 'sealed(the private key)',
      ...extra,
    };
  }

  it('does not reach for a target that was never configured', async () => {
    const post = uploader();
    const service = new BackupService({
      uow,
      settings: settings({ ...fresh(), enabled: true }),
      store: store(),
      uploader: post,
      secrets,
      clock: at('2026-10-10T09:00:00Z'),
    });

    const report = await service.run();

    expect(post.asked).toEqual([]);
    // Null, not false: nothing was owed, so there is nothing to have failed.
    expect(report.uploaded).toBeNull();
    expect(report.uploadError).toBeNull();
  });

  it('hands over the opened credential and the copy that was just taken', async () => {
    const rows = settings(configured());
    const post = uploader();
    const service = new BackupService({
      uow,
      settings: rows,
      store: store(),
      uploader: post,
      secrets,
      clock: at('2026-10-10T09:00:00Z'),
    });

    const report = await service.run();

    expect(report).toMatchObject({ ok: true, uploaded: true, uploadError: null });
    expect(post.asked).toEqual([
      {
        path: '/backups/20261010T090000Z',
        name: '20261010T090000Z',
        target: TARGET,
        // Opened, because the far machine cannot authenticate with ciphertext.
        secret: 'the private key',
        knownHostFingerprint: null,
      },
    ]);
    expect(rows.row().lastUploadAt).toEqual(new Date('2026-10-10T09:00:00Z'));
    expect(rows.row().lastUploadError).toBeNull();
  });

  it('keeps the copy and reports the reason when the upload fails', async () => {
    const rows = settings(configured());
    const service = new BackupService({
      uow,
      settings: rows,
      store: store(),
      uploader: uploader({ fail: 'connect ECONNREFUSED 10.0.0.9:22' }),
      secrets,
      clock: at('2026-10-10T09:00:00Z'),
    });

    const report = await service.run();

    // The local copy was taken, and a copy on this machine is a backup
    // (ADR 0040). The run did not fail; the upload did.
    expect(report).toMatchObject({
      ok: true,
      name: '20261010T090000Z',
      error: null,
      uploaded: false,
      uploadError: 'connect ECONNREFUSED 10.0.0.9:22',
    });
    expect(rows.row().lastError).toBeNull();
    expect(rows.row().lastUploadAt).toBeNull();
    expect(rows.row().lastUploadError).toBe('connect ECONNREFUSED 10.0.0.9:22');
  });

  it('says so rather than quietly keeping one copy when nothing can send it', async () => {
    const rows = settings(configured());
    // A server built without an uploader, which is what a test does and what a
    // misassembled installation would do. The operator configured a target.
    const service = new BackupService({
      uow,
      settings: rows,
      store: store(),
      secrets,
      clock: at('2026-10-10T09:00:00Z'),
    });

    const report = await service.run();

    expect(report.uploaded).toBe(false);
    expect(rows.row().lastUploadError).toMatch(/cannot be opened/u);
  });

  it('pins the host key the first connection met, and offers it back after', async () => {
    const rows = settings(configured());
    const post = uploader({ presents: 'SHA256:zTt+Yq' });
    const options = {
      uow,
      settings: rows,
      store: store(),
      uploader: post,
      secrets,
      clock: at('2026-10-10T09:00:00Z'),
    };

    await new BackupService(options).run();
    expect(rows.row().targetHostFingerprint).toBe('SHA256:zTt+Yq');
    expect((await new BackupService(options).settings()).targetHostFingerprint).toBe(
      'SHA256:zTt+Yq',
    );

    await new BackupService(options).run();
    // The second run hands the pin over, which is what makes it a pin rather
    // than a note: the uploader has something to refuse a different key against.
    expect(post.asked[1]?.knownHostFingerprint).toBe('SHA256:zTt+Yq');
  });

  it('keeps the pin when a connection is refused', async () => {
    const rows = settings(configured({ targetHostFingerprint: 'SHA256:zTt+Yq' }));
    const service = new BackupService({
      uow,
      settings: rows,
      store: store(),
      uploader: uploader({ fail: 'the host key of backup.example changed' }),
      secrets,
      clock: at('2026-10-10T09:00:00Z'),
    });

    await service.run();

    // Forgetting it here would turn one refused connection into permission for
    // the next one.
    expect(rows.row().targetHostFingerprint).toBe('SHA256:zTt+Yq');
  });

  it('forgets the pin when the operator names another machine', async () => {
    const rows = settings(configured({ targetHostFingerprint: 'SHA256:zTt+Yq' }));
    const service = new BackupService({ uow, settings: rows, store: store(), secrets });

    await service.save({
      enabled: true,
      intervalHours: 24,
      retentionDays: 14,
      target: { ...TARGET, host: 'elsewhere.example' },
      targetSecret: 'the private key',
    });

    expect(rows.row().targetHostFingerprint).toBeNull();
  });

  it('forgets the pin when the port changes, because that may be another machine', async () => {
    const rows = settings(configured({ targetHostFingerprint: 'SHA256:zTt+Yq' }));
    const service = new BackupService({ uow, settings: rows, store: store(), secrets });

    await service.save({
      enabled: true,
      intervalHours: 24,
      retentionDays: 14,
      target: { ...TARGET, port: 2222 },
    });

    expect(rows.row().targetHostFingerprint).toBeNull();
  });

  it('keeps the pin when only the account changes', async () => {
    const rows = settings(configured({ targetHostFingerprint: 'SHA256:zTt+Yq' }));
    const service = new BackupService({ uow, settings: rows, store: store(), secrets });

    await service.save({
      enabled: true,
      intervalHours: 24,
      retentionDays: 14,
      target: { ...TARGET, username: 'copies', directory: '/srv/elsewhere' },
    });

    // The same machine will answer. A pin is a fact about a machine, and a user
    // and a directory are facts about an account on it.
    expect(rows.row().targetHostFingerprint).toBe('SHA256:zTt+Yq');
  });

  it('forgets the pin with the target', async () => {
    const rows = settings(configured({ targetHostFingerprint: 'SHA256:zTt+Yq' }));
    const service = new BackupService({ uow, settings: rows, store: store(), secrets });

    await service.save({ enabled: true, intervalHours: 24, retentionDays: 14, target: null });

    expect(rows.row().targetHostFingerprint).toBeNull();
  });
});
