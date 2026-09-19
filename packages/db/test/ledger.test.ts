import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { ActorId, WorkspaceId } from '@knoverge/contracts';
import {
  BootstrapService,
  EventLedger,
  UserService,
  WorkspaceService,
  parseLedgerKey,
  type EventRecord,
} from '@knoverge/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createActorRepository,
  createDatabase,
  createEventRepository,
  createMembershipRepository,
  createUnitOfWork,
  createUserRepository,
  createWorkspaceRepository,
  runMigrations,
  type DatabaseHandle,
} from '../src/index.ts';

const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));
const key = parseLedgerKey('c'.repeat(64));

let container: StartedPostgreSqlContainer;
let handle: DatabaseHandle;
let ledger: EventLedger;
let service: WorkspaceService;
let workspaceId: WorkspaceId;
let systemActorId: ActorId;

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  handle = createDatabase({ connectionString: container.getConnectionUri(), max: 8 });
  await runMigrations(handle.db, migrationsFolder);
  const events = createEventRepository(handle.db);
  const workspaces = createWorkspaceRepository(handle.db);
  const actors = createActorRepository(handle.db);
  ledger = new EventLedger({ key, events });
  service = new WorkspaceService({ uow: createUnitOfWork(handle.db), workspaces, actors, ledger });
  const ws = await service.create({ slug: 'personal', name: 'Personal', requestId: 'req-1' });
  workspaceId = ws.id;
  systemActorId = (await actors.findSystemActor(workspaceId))!.id;
});

afterAll(async () => {
  await handle?.close();
  await container?.stop();
});

describe('WorkspaceService.create', () => {
  it('creates the workspace, its system actor and the first ledger event', async () => {
    const events = await createEventRepository(handle.db).listAfter(workspaceId, 0, 10);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      sequence: 1,
      eventType: 'workspace.created',
      objectId: workspaceId,
      actorId: systemActorId,
      metadata: { slug: 'personal' },
    });
  });

  it('rejects a duplicate slug without side effects', async () => {
    await expect(
      service.create({ slug: 'personal', name: 'Again', requestId: 'req-2' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(await createWorkspaceRepository(handle.db).list()).toHaveLength(1);
  });

  it('turns a slug race into a validation error', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, (_, i) =>
        service.create({ slug: 'raced', name: `Race ${i}`, requestId: `race-${i}` }),
      ),
    );
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(3);
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toMatchObject({ code: 'VALIDATION_ERROR' });
    }
    expect(
      (await ledger.verify((fulfilled[0] as PromiseFulfilledResult<{ id: WorkspaceId }>).value.id))
        .count,
    ).toBe(1);
  });

  it('validates slug and name', async () => {
    await expect(
      service.create({ slug: 'Bad Slug', name: 'x', requestId: 'r' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(service.create({ slug: 'ok', name: '   ', requestId: 'r' })).rejects.toMatchObject(
      {
        code: 'VALIDATION_ERROR',
      },
    );
  });
});

describe('event ledger in PostgreSQL', () => {
  const actor = () => ({ actorId: systemActorId, requestId: 'req' });

  it('appends with gapless sequences and verifies', async () => {
    const uow = createUnitOfWork(handle.db);
    await uow.run((tx) =>
      ledger.append(tx, workspaceId, actor(), {
        eventType: 'user.created',
        objectType: 'user',
        objectId: 'usr_x',
        metadata: { email_hash: 'sha256:abc' },
      }),
    );
    const result = await ledger.verify(workspaceId);
    expect(result).toEqual({ ok: true, count: 2 });
  });

  it('serialises concurrent appends into a gapless sequence', async () => {
    const uow = createUnitOfWork(handle.db);
    const before = (await createEventRepository(handle.db).listAfter(workspaceId, 0, 1000)).length;
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        uow.run((tx) =>
          ledger.append(tx, workspaceId, actor(), {
            eventType: 'membership.created',
            objectType: 'membership',
            objectId: `m_${i}`,
          }),
        ),
      ),
    );
    const all = await createEventRepository(handle.db).listAfter(workspaceId, 0, 1000);
    expect(all).toHaveLength(before + 12);
    expect(all.map((e) => e.sequence)).toEqual(all.map((_, i) => i + 1));
    expect((await ledger.verify(workspaceId)).ok).toBe(true);
  });

  it('rolls the event back together with the domain change', async () => {
    const uow = createUnitOfWork(handle.db);
    const before = (await createEventRepository(handle.db).listAfter(workspaceId, 0, 1000)).length;
    await expect(
      uow.run(async (tx) => {
        await ledger.append(tx, workspaceId, actor(), {
          eventType: 'agent.created',
          objectType: 'agent',
          objectId: 'ag_rollback',
        });
        throw new Error('domain failure after the event');
      }),
    ).rejects.toThrow('domain failure');
    const after = (await createEventRepository(handle.db).listAfter(workspaceId, 0, 1000)).length;
    expect(after).toBe(before);
    expect((await ledger.verify(workspaceId)).ok).toBe(true);
  });

  it('rejects UPDATE and DELETE at the database level', async () => {
    const rootCause = (err: unknown): string =>
      err instanceof Error && err.cause instanceof Error ? err.cause.message : String(err);
    const update = await handle.db
      .execute(sql`UPDATE events SET object_id = 'x' WHERE workspace_id = ${workspaceId}`)
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect(rootCause(update)).toMatch(/append-only/);
    const del = await handle.db
      .execute(sql`DELETE FROM events WHERE workspace_id = ${workspaceId}`)
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect(rootCause(del)).toMatch(/append-only/);
  });

  it('detects tampering performed with the trigger disabled', async () => {
    await handle.db.execute(sql`ALTER TABLE events DISABLE TRIGGER events_immutable`);
    try {
      await handle.db.execute(
        sql`UPDATE events SET metadata = '{"slug":"evil"}'::jsonb WHERE workspace_id = ${workspaceId} AND sequence = 1`,
      );
    } finally {
      await handle.db.execute(sql`ALTER TABLE events ENABLE TRIGGER events_immutable`);
    }
    const result = await ledger.verify(workspaceId);
    expect(result).toMatchObject({ ok: false, brokenAt: 1, reason: 'event hash mismatch' });
  });

  it('keeps verifying after a column is added to the table', async () => {
    // Its own workspace: an earlier test deliberately breaks the shared chain.
    const ws = await service.create({ slug: 'column-probe', name: 'Column probe', requestId: 'r' });
    expect((await ledger.verify(ws.id)).ok).toBe(true);
    // The hash covers an explicit field list, so a later migration must not
    // invalidate the history of every workspace.
    await handle.db.execute(sql`ALTER TABLE events ADD COLUMN probe text`);
    try {
      expect(await ledger.verify(ws.id)).toEqual({ ok: true, count: 1 });
    } finally {
      await handle.db.execute(sql`ALTER TABLE events DROP COLUMN probe`);
    }
  });

  it('hashes metadata as the database stores it', async () => {
    const ws = await service.create({ slug: 'metadata-probe', name: 'Metadata', requestId: 'r' });
    const systemActor = await createActorRepository(handle.db).findSystemActor(ws.id);
    await createUnitOfWork(handle.db).run((tx) =>
      ledger.append(
        tx,
        ws.id,
        { actorId: systemActor!.id, requestId: 'req' },
        {
          eventType: 'agent.created',
          objectType: 'agent',
          objectId: 'ag_metadata',
          // jsonb drops an undefined value; hashing it as null would make the
          // stored row fail verification.
          metadata: { kept: 'yes', dropped: undefined, nested: { also: undefined, here: 1 } },
        },
      ),
    );
    const rows = await createEventRepository(handle.db).listAfter(ws.id, 0, 10);
    expect(rows.at(-1)?.metadata).toEqual({ kept: 'yes', nested: { here: 1 } });
    expect((await ledger.verify(ws.id)).ok).toBe(true);
  });

  it('round-trips every stored column through the repository', async () => {
    const [first] = await createEventRepository(handle.db).listAfter(workspaceId, 1, 1);
    const record: EventRecord = first!;
    expect(record.createdAt).toBeInstanceOf(Date);
    expect(record.categoryIds).toEqual([]);
    expect(record.prevEventHash).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
  });
});

describe('bootstrap concurrency', () => {
  /** Reversible hashing keeps the test fast; argon2 is covered in packages/auth. */
  const passwords = {
    hash: async (p: string) => `hashed:${p}`,
    verify: async (p: string, h: string) => h === `hashed:${p}`,
    dummyHash: async () => 'hashed:__dummy__',
  };

  it('lets exactly one of several concurrent first-run requests succeed', async () => {
    const uow = createUnitOfWork(handle.db);
    const repositories = {
      users: createUserRepository(handle.db),
      memberships: createMembershipRepository(handle.db),
      actors: createActorRepository(handle.db),
      workspaces: createWorkspaceRepository(handle.db),
    };
    const users = new UserService({ uow, users: repositories.users, passwords });
    const bootstrap = new BootstrapService({
      uow,
      users,
      workspaces: new WorkspaceService({
        uow,
        workspaces: repositories.workspaces,
        actors: repositories.actors,
        ledger,
      }),
      memberships: repositories.memberships,
      actors: repositories.actors,
      ledger,
    });

    expect(await bootstrap.isRequired()).toBe(true);
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, (_, i) =>
        bootstrap.run({
          user: {
            email: `first${i}@example.com`,
            password: 'a sufficiently long passphrase',
            displayName: `First ${i}`,
          },
          workspace: { slug: `first-${i}`, name: `First ${i}` },
          requestId: `bootstrap-${i}`,
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const rejected of results.filter((r) => r.status === 'rejected')) {
      expect((rejected as PromiseRejectedResult).reason).toMatchObject({ code: 'FORBIDDEN' });
    }
    expect(await users.count()).toBe(1);
    expect(await bootstrap.isRequired()).toBe(false);
  });
});
