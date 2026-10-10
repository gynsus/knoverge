import type { BackupAuthKind } from '@knoverge/contracts';

import type { Tx } from '../ports/unit-of-work.ts';

/**
 * How this installation backs itself up (ADR 0040).
 *
 * One record, not a collection. A schedule belongs to the installation, and a
 * copy covers the whole database, so there is nothing for a second row to mean.
 */
export interface BackupSettingsRecord {
  enabled: boolean;
  intervalHours: number;
  /** Local copies only; nothing on the far machine is removed by us. */
  retentionDays: number;
  target: BackupTargetRecord | null;
  /**
   * AES-256-GCM under the encryption key, holding a private key or a password.
   * Null when no target is configured. Never leaves the server.
   */
  targetSecretCiphertext: string | null;
  /**
   * The host key this installation accepted from the target, `SHA256:…`
   * (ADR 0041).
   *
   * Null until something has connected, and then the next upload accepts
   * whatever the target presents and stores it; afterwards nothing but the same
   * key will do. A fingerprint rather than the key, because equality is all
   * pinning needs and a digest is what an operator compares by eye.
   */
  targetHostFingerprint: string | null;
  lastRunAt: Date | null;
  /** One line, never a body: the far end is somebody else's machine. */
  lastError: string | null;
  lastUploadAt: Date | null;
  lastUploadError: string | null;
  updatedAt: Date;
}

export interface BackupTargetRecord {
  host: string;
  port: number;
  username: string;
  /** Absolute on the far machine. The server writes here and nowhere else. */
  directory: string;
  authKind: BackupAuthKind;
}

/** What a run reports, written whether it worked or not. */
export interface BackupRunOutcome {
  at: Date;
  error: string | null;
  uploadedAt: Date | null;
  uploadError: string | null;
  /**
   * Set only by the first connection that got through, which is what pins it.
   * `undefined` leaves the pin alone — including on a failed upload, because a
   * refused key is not a reason to forget the key that was accepted.
   */
  targetHostFingerprint?: string | undefined;
}

export interface BackupSettingsRepository {
  /**
   * Never null: the row is created by the migration, so the settings screen
   * has something to read on an installation that has configured nothing.
   */
  get(): Promise<BackupSettingsRecord>;
  save(
    tx: Tx,
    patch: Pick<BackupSettingsRecord, 'enabled' | 'intervalHours' | 'retentionDays'> & {
      target: BackupTargetRecord | null;
      /**
       * `undefined` leaves what is stored alone, which is how a port is changed
       * without retyping a key; `null` removes it with the target.
       */
      targetSecretCiphertext?: string | null;
      /**
       * `undefined` leaves the pin alone; `null` clears it, which is what
       * removing the target or naming another machine does.
       */
      targetHostFingerprint?: string | null;
    },
    at: Date,
  ): Promise<void>;
  /** Records what a run did. Separate from `save`, which is the operator's. */
  recordRun(tx: Tx, outcome: BackupRunOutcome): Promise<void>;
}
