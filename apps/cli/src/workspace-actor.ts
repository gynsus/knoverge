import { randomUUID } from 'node:crypto';

import { WorkspaceId } from '@knoverge/contracts';
import type { ActorContext } from '@knoverge/core';

import type { createServices } from './services.ts';

/**
 * Builds an actor context for command line operations. Commands run as the
 * workspace's system actor, so ledger events show the change came from the host.
 */
export async function systemActorContext(
  services: ReturnType<typeof createServices>,
  workspaceOption?: string,
): Promise<ActorContext> {
  const workspaces = await services.repositories.workspaces.list();
  if (workspaces.length === 0) {
    throw new Error('no workspace exists; run `knoverge bootstrap` first');
  }
  let workspace = workspaces[0]!;
  if (workspaceOption !== undefined) {
    const parsed = WorkspaceId.safeParse(workspaceOption);
    const found = parsed.success
      ? workspaces.find((w) => w.id === parsed.data)
      : workspaces.find((w) => w.slug === workspaceOption);
    if (!found) throw new Error(`unknown workspace: ${workspaceOption}`);
    workspace = found;
  } else if (workspaces.length > 1) {
    throw new Error('several workspaces exist; pass --workspace <slug or id>');
  }
  const actor = await services.repositories.actors.findSystemActor(workspace.id);
  if (!actor) throw new Error(`workspace ${workspace.id} has no system actor`);
  return {
    workspaceId: workspace.id,
    actorId: actor.id,
    actorType: 'system',
    requestId: `cli:${randomUUID()}`,
    client: 'knoverge-cli',
  };
}
