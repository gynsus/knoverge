import { z } from 'zod';

/**
 * How the server proves who it is to the machine it uploads to (ADR 0040).
 *
 * A key is the better answer and the form says so: a password is something
 * this server can read back and reuse, while a key can be revoked at the far
 * end without touching anything here. Both are offered because a target that
 * only accepts one is not a reason to have no second copy at all.
 */
export const BackupAuthKind = z.enum(['private_key', 'password']);
export type BackupAuthKind = z.infer<typeof BackupAuthKind>;

/** How often a copy is taken. Hours, because a schedule is read in hours. */
export const BackupIntervalHours = z
  .number()
  .int()
  .min(1)
  .max(24 * 7);

/**
 * How long local copies are kept.
 *
 * Days rather than a count, because days is what an operator means. A count
 * only matches it while the schedule is daily, and the schedule is a setting.
 */
export const BackupRetentionDays = z.number().int().min(1).max(365);

export const BackupTarget = z.object({
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().trim().min(1).max(64),
  /** Absolute on the far machine. The server writes here and nowhere else. */
  directory: z.string().trim().min(1).max(1024),
  auth_kind: BackupAuthKind,
});
export type BackupTarget = z.infer<typeof BackupTarget>;

/**
 * What the settings screen shows.
 *
 * The secret is never here. `target_secret_set` says whether one is stored,
 * the way the AI settings say whether a provider holds a key.
 */
export const BackupSettings = z.object({
  enabled: z.boolean(),
  interval_hours: BackupIntervalHours,
  retention_days: BackupRetentionDays,
  target: BackupTarget.nullable(),
  target_secret_set: z.boolean(),
  /**
   * Whether a remote target can be configured at all. False on an installation
   * with no `KNOVERGE_ENCRYPTION_KEY`: refusing is better than storing a
   * credential the operator believes is encrypted.
   */
  secret_storage_configured: z.boolean(),
  last_run_at: z.iso.datetime().nullable(),
  /** One line, never a body: the far end is somebody else's machine. */
  last_error: z.string().nullable(),
  /** Of the last run, when it reached the target. */
  last_upload_at: z.iso.datetime().nullable(),
  last_upload_error: z.string().nullable(),
});
export type BackupSettings = z.infer<typeof BackupSettings>;

export const SaveBackupSettingsRequest = z.object({
  enabled: z.boolean(),
  interval_hours: BackupIntervalHours.default(24),
  retention_days: BackupRetentionDays.default(14),
  /** Null removes the target and the secret with it. */
  target: BackupTarget.nullable().default(null),
  /**
   * The key or the password, in clear, once. Absent leaves what is stored
   * alone, which is how a port can be changed without retyping a key.
   */
  target_secret: z.string().min(1).max(8192).optional(),
});
export type SaveBackupSettingsRequest = z.infer<typeof SaveBackupSettingsRequest>;

export const BackupSettingsResponse = z.object({ settings: BackupSettings });
export type BackupSettingsResponse = z.infer<typeof BackupSettingsResponse>;

/** One copy on this machine, as the screen lists them. */
export const BackupSummary = z.object({
  name: z.string(),
  taken_at: z.iso.datetime(),
  size_bytes: z.number().int().nonnegative(),
  /** Null until it has been tried; false with a reason on the settings. */
  uploaded: z.boolean().nullable(),
});
export type BackupSummary = z.infer<typeof BackupSummary>;

export const BackupsResponse = z.object({ backups: z.array(BackupSummary) });
export type BackupsResponse = z.infer<typeof BackupsResponse>;
