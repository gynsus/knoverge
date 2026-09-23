import type { ActorId, WorkspaceId } from '@knoverge/contracts';
import type { ActorRecord, WorkspaceRecord } from '@knoverge/core';
import { describe, expect, it } from 'vitest';

import { systemActorContext } from '../src/workspace-actor.ts';

function workspace(slug: string, id: string): WorkspaceRecord {
  return {
    id: id as WorkspaceId,
    slug,
    name: slug,
    description: null,
    defaultLanguage: 'en',
    settings: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    archivedAt: null,
  };
}

function systemActor(workspaceId: string): ActorRecord {
  return {
    id: `act_${workspaceId.slice(3)}` as ActorId,
    workspaceId: workspaceId as WorkspaceId,
    type: 'system',
    displayName: 'Knoverge',
    userId: null,
    agentId: null,
    createdAt: new Date(),
    disabledAt: null,
  };
}

/** Only the parts systemActorContext touches. */
function services(workspaces: WorkspaceRecord[], withActor = true) {
  return {
    repositories: {
      workspaces: { list: async () => workspaces },
      actors: {
        findSystemActor: async (id: WorkspaceId) =>
          withActor && workspaces.some((w) => w.id === id) ? systemActor(id) : null,
      },
    },
  } as unknown as Parameters<typeof systemActorContext>[0];
}

const ONE = workspace('personal', 'ws_01J8Z3M4Q9V0X7K2B5N6P8R1T3');
const TWO = workspace('team', 'ws_01J8Z3M4Q9V0X7K2B5N6P8R1T4');

describe('systemActorContext', () => {
  it('uses the only workspace when there is one', async () => {
    const actor = await systemActorContext(services([ONE]));
    expect(actor).toMatchObject({
      workspaceId: ONE.id,
      actorType: 'system',
      client: 'knoverge-cli',
    });
    expect(actor.requestId).toMatch(/^cli:/);
  });

  it('asks which workspace when there are several', async () => {
    await expect(systemActorContext(services([ONE, TWO]))).rejects.toThrow(/--workspace/);
  });

  it('selects by slug or by id', async () => {
    expect((await systemActorContext(services([ONE, TWO]), 'team')).workspaceId).toBe(TWO.id);
    expect((await systemActorContext(services([ONE, TWO]), TWO.id)).workspaceId).toBe(TWO.id);
  });

  it('reports an unknown workspace and an empty installation', async () => {
    await expect(systemActorContext(services([ONE, TWO]), 'nope')).rejects.toThrow(
      /unknown workspace/,
    );
    await expect(systemActorContext(services([]))).rejects.toThrow(/bootstrap/);
  });

  it('reports a workspace with no system actor rather than acting without one', async () => {
    await expect(systemActorContext(services([ONE], false))).rejects.toThrow(/system actor/);
  });
});
