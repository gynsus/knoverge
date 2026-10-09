import type { BackupAuthKind } from '@knoverge/contracts';
import type {
  BackupRunOutcome,
  BackupSettingsRecord,
  BackupSettingsRepository,
  Tx,
} from '@knoverge/core';
import { eq } from 'drizzle-orm';

import type { Database } from '../client.ts';
import { backupSettings } from '../schema/backups.ts';
import { asTx } from '../unit-of-work.ts';

/** The one row's key. The CHECK in the migration is what keeps it the one row. */
const SINGLETON = 'singleton';

function toRecord(row: typeof backupSettings.$inferSelect): BackupSettingsRecord {
  return {
    enabled: row.enabled,
    intervalHours: row.intervalHours,
    retentionDays: row.retentionDays,
    // All of the target or none of it: the CHECK in the migration says so, and
    // reading it back any other way would describe a half-configured target
    // the database cannot hold.
    target:
      row.targetHost === null
        ? null
        : {
            host: row.targetHost,
            port: row.targetPort as number,
            username: row.targetUsername as string,
            directory: row.targetDirectory as string,
            authKind: row.targetAuthKind as BackupAuthKind,
          },
    targetSecretCiphertext: row.targetSecretCiphertext,
    lastRunAt: row.lastRunAt,
    lastError: row.lastError,
    lastUploadAt: row.lastUploadAt,
    lastUploadError: row.lastUploadError,
    updatedAt: row.updatedAt,
  };
}

export function createBackupSettingsRepository(db: Database): BackupSettingsRepository {
  return {
    async get() {
      const [row] = await db
        .select()
        .from(backupSettings)
        .where(eq(backupSettings.id, SINGLETON))
        .limit(1);
      // The migration inserts it, so this cannot be missing on a migrated
      // database. Saying so here rather than returning a default means a
      // database that lost the row fails loudly instead of quietly backing up
      // on a schedule nobody chose.
      if (!row) throw new Error('backup settings row is missing');
      return toRecord(row);
    },

    async save(tx: Tx, patch, at: Date) {
      await asTx(tx)
        .update(backupSettings)
        .set({
          enabled: patch.enabled,
          intervalHours: patch.intervalHours,
          retentionDays: patch.retentionDays,
          targetHost: patch.target?.host ?? null,
          targetPort: patch.target?.port ?? null,
          targetUsername: patch.target?.username ?? null,
          targetDirectory: patch.target?.directory ?? null,
          targetAuthKind: patch.target?.authKind ?? null,
          // Absent leaves the stored secret alone, which is how a port is
          // changed without retyping a key. Removing the target removes it.
          ...(patch.target === null
            ? { targetSecretCiphertext: null }
            : patch.targetSecretCiphertext !== undefined
              ? { targetSecretCiphertext: patch.targetSecretCiphertext }
              : {}),
          updatedAt: at,
        })
        .where(eq(backupSettings.id, SINGLETON));
    },

    async recordRun(tx: Tx, outcome: BackupRunOutcome) {
      await asTx(tx)
        .update(backupSettings)
        .set({
          lastRunAt: outcome.at,
          lastError: outcome.error,
          lastUploadAt: outcome.uploadedAt,
          lastUploadError: outcome.uploadError,
          updatedAt: outcome.at,
        })
        .where(eq(backupSettings.id, SINGLETON));
    },
  };
}
