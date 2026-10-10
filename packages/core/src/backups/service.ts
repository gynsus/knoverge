import type { BackupAuthKind } from '@knoverge/contracts';

import { DomainError } from '../errors.ts';
import type { Clock } from '../ports/clock.ts';
import { systemClock } from '../ports/clock.ts';
import type { UnitOfWork } from '../ports/unit-of-work.ts';
import type {
  BackupSettingsRecord,
  BackupSettingsRepository,
  BackupTargetRecord,
} from './repository.ts';

/** One copy on this machine, as the store found it. */
export interface StoredBackupInfo {
  name: string;
  takenAt: Date;
  sizeBytes: number;
}

/** What one run produced. */
export interface TakenBackup {
  name: string;
  path: string;
  /** Copies rotation removed because they fell out of the window. */
  removed: string[];
}

/**
 * Where the copies actually come from and go.
 *
 * A port, so the domain decides whether and when without knowing that the
 * answer involves `pg_dump`, a write lock and a tar file. `packages/backups`
 * is the implementation the server hands over; a test hands over something
 * that takes a millisecond.
 */
export interface BackupStore {
  take(options: { retentionDays: number; now: Date }): Promise<TakenBackup>;
  list(): Promise<StoredBackupInfo[]>;
}

/** What the settings screen is shown. Never the secret, only that there is one. */
export interface BackupSettingsView {
  enabled: boolean;
  intervalHours: number;
  retentionDays: number;
  target: BackupTargetRecord | null;
  targetSecretSet: boolean;
  /** Whether a target can be configured at all: there is an encryption key. */
  secretStorageConfigured: boolean;
  lastRunAt: Date | null;
  lastError: string | null;
  lastUploadAt: Date | null;
  lastUploadError: string | null;
}

export interface SaveBackupSettingsInput {
  enabled: boolean;
  intervalHours: number;
  retentionDays: number;
  target: BackupTargetRecord | null;
  /**
   * The key or the password, in clear, once. Absent leaves what is stored
   * alone, which is how a port is changed without retyping a key.
   */
  targetSecret?: string | undefined;
}

/** One copy, and whether it reached the target. */
export interface BackupListEntry extends StoredBackupInfo {
  /**
   * Null when nothing is known: no target, or a copy taken before the current
   * target was configured. The settings carry the state of the last upload and
   * nothing carries the state of an older one, so this claims nothing about a
   * copy it cannot speak for.
   */
  uploaded: boolean | null;
}

/** What `run` did, for a log line or for the operator who pressed the button. */
export interface BackupRunReport {
  ok: boolean;
  name: string | null;
  removed: string[];
  error: string | null;
}

/**
 * Whether this installation keeps copies of itself, and the job that does it.
 *
 * The default is off and stays off (ADR 0040). What changed is that the absence
 * is visible: there is a row from the first migration, a screen that reads it,
 * and a job that asks it every hour whether it is time.
 *
 * These changes are not ledger events, for the reason provider settings are
 * not: the ledger records what happened to knowledge and to who may change it,
 * keyed by a per-workspace sequence, and a backup belongs to the installation
 * and has no workspace to be recorded in. The server logs the change instead.
 */
export class BackupService {
  private readonly o: BackupServiceOptions;
  private readonly clock: Clock;

  constructor(options: BackupServiceOptions) {
    this.o = options;
    this.clock = options.clock ?? systemClock;
  }

  async settings(): Promise<BackupSettingsView> {
    return this.view(await this.o.settings.get());
  }

  /**
   * What the operator chose.
   *
   * The whole setting at once rather than a patch: a schedule, a window and a
   * target are read together on one screen and a half-applied change to them
   * is a copy going somewhere nobody meant.
   */
  async save(input: SaveBackupSettingsInput): Promise<BackupSettingsView> {
    const current = await this.o.settings.get();
    const target = input.target ? normaliseTarget(input.target) : null;
    const ciphertext = this.secretFor(current, target, input.targetSecret);
    await this.o.uow.run((tx) =>
      this.o.settings.save(
        tx,
        {
          enabled: input.enabled,
          intervalHours: input.intervalHours,
          retentionDays: input.retentionDays,
          target,
          ...(ciphertext === undefined ? {} : { targetSecretCiphertext: ciphertext }),
        },
        this.clock.now(),
      ),
    );
    return this.settings();
  }

  /**
   * Decides what happens to the stored credential, and refuses rather than
   * leaving a target that cannot be reached.
   *
   * `undefined` means leave it: an operator who changed the port should not
   * have to find the key again. Every other answer is a decision, and the ones
   * that would store a credential this installation cannot seal, or leave a
   * target with a secret of the wrong kind, are the ones that get refused.
   */
  private secretFor(
    current: BackupSettingsRecord,
    target: BackupTargetRecord | null,
    given: string | undefined,
  ): string | null | undefined {
    if (!target) {
      // The target goes and the credential with it: a password nothing uses is
      // a password in a database for no reason.
      return current.targetSecretCiphertext === null ? undefined : null;
    }
    if (!this.o.secrets) {
      throw new DomainError(
        'VALIDATION_ERROR',
        'this installation has no KNOVERGE_ENCRYPTION_KEY, so it cannot keep a backup credential',
      );
    }
    if (given !== undefined) return this.o.secrets.seal(given);
    // Nothing given, so whatever is stored has to still fit. A key is not a
    // password: keeping one while the form says the other would be a target
    // that authenticates with something nobody chose.
    const kept = current.targetSecretCiphertext !== null && sameKind(current, target.authKind);
    if (kept) return undefined;
    throw new DomainError(
      'VALIDATION_ERROR',
      target.authKind === 'private_key'
        ? 'give the private key this installation should authenticate with'
        : 'give the password this installation should authenticate with',
    );
  }

  /** The copies on this machine, newest first, with what is known about each. */
  async backups(): Promise<BackupListEntry[]> {
    const [stored, settings] = await Promise.all([this.o.store.list(), this.o.settings.get()]);
    const last = settings.lastRunAt?.getTime();
    return stored.map((backup) => ({
      ...backup,
      uploaded:
        settings.target === null || last === undefined || backup.takenAt.getTime() !== last
          ? null
          : settings.lastUploadAt !== null
            ? true
            : settings.lastUploadError !== null
              ? false
              : null,
    }));
  }

  /**
   * Takes one now, whatever the schedule says.
   *
   * What an operator pressing the button means, and what the job calls once it
   * has decided it is time. A failure is recorded and returned rather than
   * thrown: the run happened, it is part of the installation's history, and the
   * screen that shows the setting is where the reason belongs.
   */
  async run(): Promise<BackupRunReport> {
    const settings = await this.o.settings.get();
    const now = this.clock.now();
    try {
      const taken = await this.o.store.take({ retentionDays: settings.retentionDays, now });
      await this.record({ at: now, error: null, uploadedAt: null, uploadError: null });
      return { ok: true, name: taken.name, removed: taken.removed, error: null };
    } catch (error) {
      const message = oneLine(error);
      await this.record({ at: now, error: message, uploadedAt: null, uploadError: null });
      return { ok: false, name: null, removed: [], error: message };
    }
  }

  /**
   * The job's question, asked every hour.
   *
   * The interval is a setting and the schedule is not, so the job runs often
   * and this says no most of the time. An installation that has never taken one
   * takes one at the first tick after it is turned on, rather than waiting out
   * an interval from a moment nobody chose.
   */
  async runIfDue(): Promise<
    { ran: false; reason: string } | { ran: true; report: BackupRunReport }
  > {
    const settings = await this.o.settings.get();
    if (!settings.enabled) return { ran: false, reason: 'backups are off' };
    const due =
      settings.lastRunAt === null ||
      this.clock.now().getTime() - settings.lastRunAt.getTime() >=
        settings.intervalHours * 60 * 60 * 1000;
    if (!due) return { ran: false, reason: 'not due yet' };
    return { ran: true, report: await this.run() };
  }

  private async record(outcome: Parameters<BackupSettingsRepository['recordRun']>[1]) {
    await this.o.uow.run((tx) => this.o.settings.recordRun(tx, outcome));
  }

  private view(record: BackupSettingsRecord): BackupSettingsView {
    return {
      enabled: record.enabled,
      intervalHours: record.intervalHours,
      retentionDays: record.retentionDays,
      target: record.target,
      targetSecretSet: record.targetSecretCiphertext !== null,
      secretStorageConfigured: this.o.secrets !== undefined,
      lastRunAt: record.lastRunAt,
      lastError: record.lastError,
      lastUploadAt: record.lastUploadAt,
      lastUploadError: record.lastUploadError,
    };
  }
}

export interface BackupServiceOptions {
  uow: UnitOfWork;
  settings: BackupSettingsRepository;
  store: BackupStore;
  /**
   * Sealing and opening the target's credential, when this installation can.
   *
   * Absent without a `KNOVERGE_ENCRYPTION_KEY`, and then a target cannot be
   * configured at all — the same answer webhooks and providers give, for the
   * same reason: a credential in a column in clear is worse than a feature that
   * is not configured (ADR 0033).
   */
  secrets?: { seal: (plaintext: string) => string; open: (sealed: string) => string };
  clock?: Clock;
}

/** Whether what is stored was stored for the kind the form now asks for. */
function sameKind(current: BackupSettingsRecord, authKind: BackupAuthKind): boolean {
  return current.target !== null && current.target.authKind === authKind;
}

/**
 * The target as it will be used.
 *
 * The directory has to be absolute, because a relative one is resolved against
 * whatever home directory the far machine gives that user — which is not a
 * place an operator chose, and not the same place after their account changes.
 */
function normaliseTarget(target: BackupTargetRecord): BackupTargetRecord {
  const directory = target.directory.replace(/\/+$/u, '') || '/';
  if (!directory.startsWith('/')) {
    throw new DomainError(
      'VALIDATION_ERROR',
      'the directory on the target machine must be an absolute path',
    );
  }
  return { ...target, directory };
}

/**
 * A failure as one line.
 *
 * Messages only, never a body or a cause chain: what fails here is a program
 * that failed, and its report quotes the whole command line it was given —
 * host, port, user and database — into a field a screen shows.
 */
function oneLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll(/\s+/gu, ' ').trim().slice(0, 500) || 'the backup could not be taken';
}
