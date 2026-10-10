import type { BackupSource } from '@knoverge/backups';
import type { WorkspaceId } from '@knoverge/contracts';

import type { Services } from './run.ts';

/**
 * The installation, as the backup package asks about it.
 *
 * The mechanism itself lives in `@knoverge/backups`, because the scheduled job
 * in the server takes the same copy by the same steps (ADR 0040) and two
 * implementations of one backup would be two formats to restore.
 */
export function backupSource(services: Services): BackupSource {
  return {
    workspaces: () => services.repositories.workspaces.list(),
    latestSequence: (workspaceId) =>
      services.repositories.events.latestSequence(workspaceId as WorkspaceId),
    withWorkspaceLock: (workspaceId, fn) => services.uow.withWorkspaceLock(workspaceId, fn),
  };
}
