import {
  BackupSettingsResponse,
  BackupsResponse,
  SaveBackupSettingsRequest,
  TakeBackupResponse,
  type BackupSettings,
} from '@knoverge/contracts';
import type { BackupListEntry, BackupSettingsView } from '@knoverge/core';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import { requirePermission } from '../plugins/actor-context.ts';
import { csrfUnlessBearer } from '../plugins/security.ts';
import type { Services } from '../services.ts';

function settings(view: BackupSettingsView): BackupSettings {
  return {
    enabled: view.enabled,
    interval_hours: view.intervalHours,
    retention_days: view.retentionDays,
    target: view.target
      ? {
          host: view.target.host,
          port: view.target.port,
          username: view.target.username,
          directory: view.target.directory,
          auth_kind: view.target.authKind,
        }
      : null,
    // Whether, never which: the credential goes to the target machine and comes
    // back to nobody (ADR 0033).
    target_secret_set: view.targetSecretSet,
    secret_storage_configured: view.secretStorageConfigured,
    target_host_fingerprint: view.targetHostFingerprint,
    last_run_at: view.lastRunAt?.toISOString() ?? null,
    last_error: view.lastError,
    last_upload_at: view.lastUploadAt?.toISOString() ?? null,
    last_upload_error: view.lastUploadError,
  };
}

function summary(backup: BackupListEntry) {
  return {
    name: backup.name,
    taken_at: backup.takenAt.toISOString(),
    size_bytes: backup.sizeBytes,
    uploaded: backup.uploaded,
  };
}

/**
 * Backup administration.
 *
 * Administration, not a tool: these are never offered to an agent and have no
 * MCP name to match (rule 11, ADR 0011). They require `workspace.admin`, which
 * no agent trust tier holds — and they are about the installation rather than
 * about any one workspace, which is the same widening AI settings have and the
 * same gap ADR 0021 records.
 */
export function registerAdminBackupRoutes(app: FastifyInstance, services: Services): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/v1/admin/backups.settings',
    { schema: { response: { 200: BackupSettingsResponse } } },
    async (request) => {
      await requirePermission(services, request, 'workspace.admin');
      return { settings: settings(await services.backups.settings()) };
    },
  );

  r.get(
    '/v1/admin/backups.list',
    { schema: { response: { 200: BackupsResponse } } },
    async (request) => {
      await requirePermission(services, request, 'workspace.admin');
      return { backups: (await services.backups.backups()).map(summary) };
    },
  );

  r.post(
    '/v1/admin/backups.save',
    {
      onRequest: csrfUnlessBearer(app),
      schema: { body: SaveBackupSettingsRequest, response: { 200: BackupSettingsResponse } },
    },
    async (request) => {
      await requirePermission(services, request, 'workspace.admin');
      const body = request.body;
      const view = await services.backups.save({
        enabled: body.enabled,
        intervalHours: body.interval_hours,
        retentionDays: body.retention_days,
        target: body.target
          ? {
              host: body.target.host,
              port: body.target.port,
              username: body.target.username,
              directory: body.target.directory,
              authKind: body.target.auth_kind,
            }
          : null,
        ...(body.target_secret === undefined ? {} : { targetSecret: body.target_secret }),
      });
      request.log.info(
        {
          enabled: view.enabled,
          intervalHours: view.intervalHours,
          retentionDays: view.retentionDays,
          // The address, never the credential: an operator reading the log has
          // to be able to see where copies are going.
          target: view.target ? `${view.target.username}@${view.target.host}` : null,
        },
        'backup settings changed',
      );
      return { settings: settings(view) };
    },
  );

  r.post(
    '/v1/admin/backups.run',
    {
      onRequest: csrfUnlessBearer(app),
      schema: { response: { 200: TakeBackupResponse } },
    },
    async (request) => {
      await requirePermission(services, request, 'workspace.admin');
      // A failure comes back as a result rather than as a 500: the run happened,
      // it is recorded, and the reason belongs on the screen beside the setting.
      const report = await services.backups.run();
      // A copy that was taken and did not reach the target is a warning and not
      // a failure: the local copy is a backup, and the next run tries again.
      if (!report.ok) request.log.error(report, 'backup failed');
      else if (report.uploadError !== null) request.log.warn(report, 'backup not uploaded');
      else request.log.info(report, 'backup taken');
      return {
        ok: report.ok,
        name: report.name,
        removed: report.removed,
        error: report.error,
        settings: settings(await services.backups.settings()),
      };
    },
  );
}
