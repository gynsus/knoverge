import { boolean, integer, pgTable, text, varchar } from 'drizzle-orm/pg-core';

import { timestampTz } from './common.ts';

/**
 * How this installation backs itself up (ADR 0040).
 *
 * One row, pinned by a primary key with one allowed value. Instance-level with
 * no workspace column, like the AI providers: a schedule is not a property of
 * one workspace, and a copy covers the whole database anyway.
 *
 * The row exists from the first migration with `enabled` false, so the settings
 * screen has something to read and says "off" rather than saying nothing. That
 * is the whole point of moving this out of a compose profile.
 */
export const backupSettings = pgTable('backup_settings', {
  /** Always `singleton`; the CHECK is what makes this one row and not a table. */
  id: varchar('id', { length: 16 }).primaryKey(),
  enabled: boolean('enabled').notNull().default(false),
  intervalHours: integer('interval_hours').notNull().default(24),
  /** Local copies only. Nothing on the far machine is ever removed by us. */
  retentionDays: integer('retention_days').notNull().default(14),

  targetHost: varchar('target_host', { length: 255 }),
  targetPort: integer('target_port'),
  targetUsername: varchar('target_username', { length: 64 }),
  targetDirectory: varchar('target_directory', { length: 1024 }),
  targetAuthKind: varchar('target_auth_kind', { length: 16 }),
  /**
   * AES-256-GCM under `KNOVERGE_ENCRYPTION_KEY`, holding a private key or a
   * password. Never served: the screen says whether one is stored, not what it
   * is. An installation with no encryption key cannot set a target at all.
   */
  targetSecretCiphertext: text('target_secret_ciphertext'),

  lastRunAt: timestampTz('last_run_at'),
  /** One line, never a body. */
  lastError: varchar('last_error', { length: 500 }),
  lastUploadAt: timestampTz('last_upload_at'),
  lastUploadError: varchar('last_upload_error', { length: 500 }),
  updatedAt: timestampTz('updated_at').notNull(),
});
