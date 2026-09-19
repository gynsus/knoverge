import type { ActorId, WorkspaceId } from '@knoverge/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  IdempotencyService,
  MaintenanceService,
  SESSION_RETENTION_MS,
  type ActorContext,
  type IdempotencyRecord,
  type IdempotencyRepository,
  type Tx,
  type UnitOfWork,
} from '../src/index.ts';

const NOW = new Date('2026-09-19T12:00:00Z');
const uow: UnitOfWork = {
  run: (fn) => fn({} as Tx),
  runExclusive: (_key, fn) => fn({} as Tx),
};
const actor: ActorContext = {
  workspaceId: 'ws_01J8Z3M4Q9V0X7K2B5N6P8R1T3' as WorkspaceId,
  actorId: 'act_01J8Z3M4Q9V0X7K2B5N6P8R1T3' as ActorId,
  actorType: 'human',
  requestId: 'req',
};

function repository() {
  const rows: IdempotencyRecord[] = [];
  const repo: IdempotencyRepository = {
    find: async (workspaceId, actorId, key) =>
      rows.find(
        (r) => r.workspaceId === workspaceId && r.actorId === actorId && r.idempotencyKey === key,
      ) ?? null,
    store: async (_tx, record) => {
      const clash = rows.findIndex(
        (r) =>
          r.workspaceId === record.workspaceId &&
          r.actorId === record.actorId &&
          r.idempotencyKey === record.idempotencyKey,
      );
      if (clash >= 0) rows[clash] = record;
      else rows.push(record);
    },
    deleteExpired: async (_tx, now) => {
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (rows[i]!.expiresAt < now) rows.splice(i, 1);
      }
      return before - rows.length;
    },
  };
  return { repo, rows };
}

function service(now = NOW) {
  const { repo, rows } = repository();
  return {
    service: new IdempotencyService({ uow, records: repo, clock: { now: () => now } }),
    rows,
  };
}

describe('IdempotencyService', () => {
  it('runs the work when no key is given', async () => {
    const { service: s, rows } = service();
    const fn = vi.fn(async () => ({ value: 1 }));
    await expect(s.run(actor, undefined, 'test.op', { a: 1 }, fn)).resolves.toEqual({
      value: { value: 1 },
      replayed: false,
    });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(0);
  });

  it('replays the first response for the same key and body', async () => {
    const { service: s } = service();
    const fn = vi.fn(async () => ({ id: `run-${fn.mock.calls.length}` }));
    const first = await s.run(actor, 'retry-key-1', 'test.op', { a: 1 }, fn);
    const second = await s.run(actor, 'retry-key-1', 'test.op', { a: 1 }, fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(second.replayed).toBe(true);
    expect(second.value).toEqual(first.value);
  });

  it('ignores the order of keys in the body when comparing requests', async () => {
    const { service: s } = service();
    const fn = vi.fn(async () => ({ ok: true }));
    await s.run(actor, 'retry-key-2', 'test.op', { a: 1, b: 2 }, fn);
    const replay = await s.run(actor, 'retry-key-2', 'test.op', { b: 2, a: 1 }, fn);
    expect(replay.replayed).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('refuses the same key with a different body', async () => {
    const { service: s } = service();
    const fn = vi.fn(async () => ({ ok: true }));
    await s.run(actor, 'retry-key-3', 'test.op', { a: 1 }, fn);
    await expect(s.run(actor, 'retry-key-3', 'test.op', { a: 2 }, fn)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('keeps keys separate per actor', async () => {
    const { service: s } = service();
    const fn = vi.fn(async () => ({ ok: true }));
    await s.run(actor, 'shared-key-1', 'test.op', { a: 1 }, fn);
    const other = { ...actor, actorId: 'act_01J8Z3M4Q9V0X7K2B5N6P8R1T4' as ActorId };
    const result = await s.run(other, 'shared-key-1', 'test.op', { a: 1 }, fn);
    expect(result.replayed).toBe(false);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('rejects a malformed key before doing any work', async () => {
    const { service: s } = service();
    const fn = vi.fn(async () => ({ ok: true }));
    await expect(s.run(actor, 'short', 'test.op', { a: 1 }, fn)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it('keeps the later response when two simultaneous calls share a key', async () => {
    // Documented behaviour: retries are what this protects against, not two
    // calls in flight at the same instant.
    const { service: s, rows } = service();
    let n = 0;
    const fn = vi.fn(async () => ({ run: (n += 1) }));
    const [first, second] = await Promise.all([
      s.run(actor, 'raced-key-1', 'test.op', { a: 1 }, fn),
      s.run(actor, 'raced-key-1', 'test.op', { a: 1 }, fn),
    ]);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(false);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.response).toEqual({ run: 2 });
  });

  it('runs again once the record has expired, and prunes it', async () => {
    const { service: s, rows } = service();
    const fn = vi.fn(async () => ({ ok: true }));
    await s.run(actor, 'expiring-key-1', 'test.op', { a: 1 }, fn);
    rows[0]!.expiresAt = new Date(NOW.getTime() - 1);
    const again = await s.run(actor, 'expiring-key-1', 'test.op', { a: 1 }, fn);
    expect(again.replayed).toBe(false);
    expect(rows).toHaveLength(1);

    rows[0]!.expiresAt = new Date(NOW.getTime() - 1);
    expect(await s.purgeExpired()).toBe(1);
    expect(rows).toHaveLength(0);
  });
});

describe('IdempotencyService.fingerprint', () => {
  it('tells two operations apart even when their requests match', () => {
    expect(IdempotencyService.fingerprint('agents.create', { a: 1 })).not.toBe(
      IdempotencyService.fingerprint('members.add', { a: 1 }),
    );
  });
});

describe('MaintenanceService', () => {
  it('removes expired idempotency records and long-dead sessions', async () => {
    const removedBefore: Date[] = [];
    const service = new MaintenanceService({
      uow,
      sessions: {
        insert: async () => undefined,
        findActiveByTokenHash: async () => null,
        listActiveForUser: async () => [],
        revoke: async () => false,
        revokeAllForUser: async () => 0,
        deleteEndedBefore: async (_tx, before) => {
          removedBefore.push(before);
          return 3;
        },
      },
      idempotency: { purgeExpired: async () => 7 } as unknown as IdempotencyService,
      clock: { now: () => NOW },
    });
    const result = await service.prune();
    expect(result).toEqual({ idempotencyRecords: 7, sessions: 3 });
    // A session row outlives the session itself, so the settings page can still
    // show where somebody was recently signed in.
    expect(NOW.getTime() - removedBefore[0]!.getTime()).toBe(SESSION_RETENTION_MS);
  });
});
