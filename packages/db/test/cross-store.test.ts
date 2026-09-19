import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { ActorId, WorkspaceId } from '@knoverge/contracts';
import {
  BootstrapService,
  CrossStoreWriter,
  EventLedger,
  RecoveryService,
  UserService,
  WorkspaceService,
  parseLedgerKey,
  type ActorContext,
} from '@knoverge/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createDatabase,
  createRepositories,
  createUnitOfWork,
  runMigrations,
  type DatabaseHandle,
} from '../src/index.ts';

/**
 * A canonical write commits to Git and then to PostgreSQL. These check what the
 * architecture promises when the process stops in between.
 */
const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));
const key = parseLedgerKey('e'.repeat(64));

let container: StartedPostgreSqlContainer;
let handle: DatabaseHandle;
let repositories: ReturnType<typeof createRepositories>;
let uow: ReturnType<typeof createUnitOfWork>;
let writer: CrossStoreWriter;
let workspaceId: WorkspaceId;
let actor: ActorContext;

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  handle = createDatabase({ connectionString: container.getConnectionUri(), max: 8 });
  handle.pool.on('error', () => undefined);
  await runMigrations(handle.db, migrationsFolder);
  repositories = createRepositories(handle.db);
  uow = createUnitOfWork(handle.db);
  const ledger = new EventLedger({ key, events: repositories.events });
  const users = new UserService({
    uow,
    users: repositories.users,
    passwords: {
      hash: async (p) => `hashed:${p}`,
      verify: async () => true,
      dummyHash: async () => 'hashed:x',
    },
  });
  const workspaces = new WorkspaceService({
    uow,
    workspaces: repositories.workspaces,
    actors: repositories.actors,
    ledger,
  });
  const created = await new BootstrapService({
    uow,
    users,
    workspaces,
    memberships: repositories.memberships,
    actors: repositories.actors,
    ledger,
  }).run({
    user: {
      email: 'owner@example.com',
      password: 'correct horse battery staple',
      displayName: 'Owner',
      locale: 'en',
    },
    workspace: { slug: 'personal', name: 'Personal' },
    requestId: 'bootstrap',
  });
  workspaceId = created.workspace.id;
  actor = {
    workspaceId,
    actorId: (await repositories.actors.findSystemActor(workspaceId))!.id as ActorId,
    actorType: 'system',
    requestId: 'req-1',
    client: 'test-suite',
    sessionId: 'ext:conversation-7',
  };
  writer = new CrossStoreWriter({ uow, operations: repositories.operations });
});

afterAll(async () => {
  await handle?.close().catch(() => undefined);
  await container?.stop();
});

const recovery = (options: {
  commitExists?: boolean;
  complete?: (id: string) => Promise<boolean>;
}) =>
  new RecoveryService({
    uow,
    operations: repositories.operations,
    commitExists: async () => options.commitExists ?? false,
    ...(options.complete
      ? { completeFromCommit: async (operation) => options.complete!(operation.id) }
      : {}),
  });

describe('a write that spans both stores', () => {
  it('records the operation, the commit and the database side in order', async () => {
    const seen: string[] = [];
    const result = await writer.run(actor, {
      type: 'taxonomy',
      objectIds: { category: 'cat_x' },
      commit: async (operation) => {
        // The row exists and says pending before anything is committed.
        const stored = await repositories.operations.findById(workspaceId, operation.id);
        seen.push(stored!.state);
        return { commitHash: 'a'.repeat(40), taxonomyVersion: 3 };
      },
      record: async (_tx, operation) => {
        seen.push(operation.state);
        return operation.gitCommitHash;
      },
    });
    expect(result).toBe('a'.repeat(40));
    expect(seen).toEqual(['pending', 'git_committed']);
    const finished = await repositories.operations.findById(
      workspaceId,
      (await repositories.operations.listUnfinished(workspaceId)).at(0)?.id ?? 'none',
    );
    // Nothing is left unfinished.
    expect(finished).toBeNull();
  });

  it('keeps the request context, because a recovered event has to carry it', async () => {
    let operationId = '';
    await writer.run(actor, {
      type: 'taxonomy',
      objectIds: {},
      commit: async (operation) => {
        operationId = operation.id;
        return { commitHash: 'b'.repeat(40) };
      },
      record: async () => undefined,
    });
    const stored = await repositories.operations.findById(workspaceId, operationId);
    // The Git trailers carry the actor and the workspace, not these.
    expect(stored).toMatchObject({
      requestId: 'req-1',
      client: 'test-suite',
      sessionId: 'ext:conversation-7',
      gitCommitHash: 'b'.repeat(40),
    });
  });

  it('leaves the operation failed when the commit never happened', async () => {
    await expect(
      writer.run(actor, {
        type: 'taxonomy',
        objectIds: {},
        commit: async () => {
          throw new Error('git is unavailable');
        },
        record: async () => undefined,
      }),
    ).rejects.toThrow('git is unavailable');
    const unfinished = await repositories.operations.listUnfinished(workspaceId);
    // failed is not unfinished: it has been decided.
    expect(unfinished).toHaveLength(0);
  });

  it('leaves the operation at git_committed when the database side dies', async () => {
    await expect(
      writer.run(actor, {
        type: 'taxonomy',
        objectIds: { category: 'cat_y' },
        commit: async () => ({ commitHash: 'c'.repeat(40) }),
        record: async () => {
          throw new Error('the process stops here');
        },
      }),
    ).rejects.toThrow('the process stops here');
    const unfinished = await repositories.operations.listUnfinished(workspaceId);
    expect(unfinished).toHaveLength(1);
    expect(unfinished[0]).toMatchObject({
      state: 'git_committed',
      gitCommitHash: 'c'.repeat(40),
      objectIds: { category: 'cat_y' },
    });
  });
});

describe('recovery', () => {
  it('completes a write that reached Git and marks it recovered', async () => {
    const before = await repositories.operations.listUnfinished(workspaceId);
    expect(before).toHaveLength(1);
    const report = await recovery({ complete: async () => true }).recover(workspaceId);
    expect(report.recovered).toEqual([before[0]!.id]);
    expect(await repositories.operations.listUnfinished(workspaceId)).toHaveLength(0);
    expect((await repositories.operations.findById(workspaceId, before[0]!.id))?.state).toBe(
      'recovered',
    );
  });

  it('abandons a pending write when no commit names it', async () => {
    // A process that died before committing leaves this behind.
    const now = new Date();
    const id = `op_01M2XCRASHCRASHCRASHCRASH1`;
    await uow.run((tx) =>
      repositories.operations.insert(tx, {
        id,
        workspaceId,
        actorId: actor.actorId,
        operationType: 'taxonomy',
        state: 'pending',
        objectIds: {},
        intendedPayloadHash: null,
        gitCommitHash: null,
        taxonomyVersion: null,
        requestId: 'req-crash',
        sessionId: null,
        agentId: null,
        client: null,
        provider: null,
        model: null,
        error: null,
        createdAt: now,
        updatedAt: now,
      }),
    );
    const report = await recovery({ commitExists: false }).recover(workspaceId);
    expect(report.failed).toEqual([id]);
    expect((await repositories.operations.findById(workspaceId, id))?.state).toBe('failed');
  });

  it('leaves a pending write alone when a commit for it does exist', async () => {
    const now = new Date();
    const id = `op_01M2XCRASHCRASHCRASHCRASH2`;
    await uow.run((tx) =>
      repositories.operations.insert(tx, {
        id,
        workspaceId,
        actorId: actor.actorId,
        operationType: 'taxonomy',
        state: 'pending',
        objectIds: {},
        intendedPayloadHash: null,
        gitCommitHash: null,
        taxonomyVersion: null,
        requestId: 'req-crash-2',
        sessionId: null,
        agentId: null,
        client: null,
        provider: null,
        model: null,
        error: null,
        createdAt: now,
        updatedAt: now,
      }),
    );
    // The process died between committing and writing the hash down. Calling
    // this failed would abandon a commit that exists.
    const report = await recovery({ commitExists: true }).recover(workspaceId);
    expect(report.unresolved).toContain(id);
    expect((await repositories.operations.findById(workspaceId, id))?.state).toBe('pending');
  });
});

describe('the workspace write lock', () => {
  it('lets one write at a time through, across transactions', async () => {
    const order: string[] = [];
    const slow = uow.withWorkspaceLock(workspaceId, async () => {
      order.push('first in');
      await new Promise((resolve) => setTimeout(resolve, 150));
      order.push('first out');
    });
    // Started while the first holds the lock on another connection.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = uow.withWorkspaceLock(workspaceId, async () => {
      order.push('second in');
    });
    await Promise.all([slow, second]);
    expect(order).toEqual(['first in', 'first out', 'second in']);
  });

  it('does not block a different workspace', async () => {
    const other = await new WorkspaceService({
      uow,
      workspaces: repositories.workspaces,
      actors: repositories.actors,
      ledger: new EventLedger({ key, events: repositories.events }),
    }).create({ slug: 'other', name: 'Other', requestId: 'r' });
    let released = false;
    const held = uow.withWorkspaceLock(workspaceId, async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      released = true;
    });
    await uow.withWorkspaceLock(other.id, async () => {
      expect(released).toBe(false);
    });
    await held;
  });
});
