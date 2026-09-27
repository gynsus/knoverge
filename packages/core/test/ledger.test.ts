import type { ActorId, WorkspaceId } from '@knoverge/contracts';
import { describe, expect, it } from 'vitest';

import {
  EventLedger,
  computeEventHash,
  fingerprint,
  genesisHash,
  keyring,
  parseLedgerKey,
  type EventRecord,
  type EventFeedOptions,
  type EventRepository,
  type Tx,
} from '../src/index.ts';

const key = parseLedgerKey('a'.repeat(64));
const otherKey = parseLedgerKey('b'.repeat(64));
const ws = 'ws_01J8Z3M4Q9V0X7K2B5N6P8R1T3' as WorkspaceId;
const tx = {} as Tx;

/** Scoped by workspace, like the real repository, so per-workspace chains are testable. */
class MemoryEvents implements EventRepository {
  rows: EventRecord[] = [];

  private forWorkspace(workspaceId: WorkspaceId) {
    return this.rows.filter((r) => r.workspaceId === workspaceId);
  }

  async lockAndGetHead(_tx: Tx, workspaceId: WorkspaceId) {
    const last = this.forWorkspace(workspaceId).at(-1);
    return last ? { sequence: last.sequence, eventHash: last.eventHash } : null;
  }

  async insert(_tx: Tx, record: EventRecord) {
    this.rows.push(record);
  }

  async listAfter(workspaceId: WorkspaceId, after: number, limit: number) {
    return this.forWorkspace(workspaceId)
      .filter((r) => r.sequence > after)
      .slice(0, limit);
  }

  async latestSequence(workspaceId: WorkspaceId) {
    return this.forWorkspace(workspaceId).at(-1)?.sequence ?? 0;
  }

  async listFeed(workspaceId: WorkspaceId, options: EventFeedOptions) {
    return this.forWorkspace(workspaceId)
      .filter((r) => r.sequence > options.afterSequence)
      .filter((r) => !options.eventTypes?.length || options.eventTypes.includes(r.eventType))
      .filter((r) => !options.actorId || r.actorId === options.actorId)
      .filter(
        (r) =>
          !options.categoryIds?.length ||
          r.categoryIds.some((id) => options.categoryIds!.includes(id)),
      )
      .slice(0, options.limit);
  }
}

function ledgerWith(events: EventRepository) {
  return new EventLedger({ key, events, clock: { now: () => new Date('2026-09-19T00:00:00Z') } });
}

async function appendThree(ledger: EventLedger) {
  const actor = { actorId: 'act_1' as ActorId, requestId: 'req' };
  await ledger.append(tx, ws, actor, {
    eventType: 'workspace.created',
    objectType: 'workspace',
    objectId: ws,
  });
  await ledger.append(tx, ws, actor, {
    eventType: 'user.created',
    objectType: 'user',
    objectId: 'usr_1',
  });
  await ledger.append(tx, ws, actor, {
    eventType: 'membership.created',
    objectType: 'membership',
    objectId: 'm_1',
  });
}

describe('parseLedgerKey', () => {
  it('requires hex and at least 32 bytes', () => {
    expect(() => parseLedgerKey('zz')).toThrow(/hex/);
    expect(() => parseLedgerKey('ab'.repeat(16))).toThrow(/32 bytes/);
    expect(parseLedgerKey('ab'.repeat(32)).bytes).toHaveLength(32);
  });
});

describe('EventLedger', () => {
  it('chains events with gapless sequences from the genesis hash', async () => {
    const events = new MemoryEvents();
    await appendThree(ledgerWith(events));
    expect(events.rows.map((r) => r.sequence)).toEqual([1, 2, 3]);
    expect(events.rows[0]?.prevEventHash).toBe(genesisHash(key));
    expect(events.rows[1]?.prevEventHash).toBe(events.rows[0]?.eventHash);
    expect(events.rows[2]?.prevEventHash).toBe(events.rows[1]?.eventHash);
  });

  it('verifies an intact chain', async () => {
    const events = new MemoryEvents();
    const ledger = ledgerWith(events);
    await appendThree(ledger);
    await expect(ledger.verify(ws, 2)).resolves.toEqual({ ok: true, count: 3 });
  });

  it('detects a modified event', async () => {
    const events = new MemoryEvents();
    const ledger = ledgerWith(events);
    await appendThree(ledger);
    events.rows[1] = { ...events.rows[1]!, objectId: 'usr_tampered' };
    const result = await ledger.verify(ws);
    expect(result).toMatchObject({ ok: false, brokenAt: 2, reason: 'event hash mismatch' });
  });

  it('detects a recomputed chain made with a different key', async () => {
    const events = new MemoryEvents();
    await appendThree(new EventLedger({ key: otherKey, events }));
    const result = await ledgerWith(events).verify(ws);
    expect(result).toMatchObject({ ok: false, brokenAt: 1 });
  });

  it('still verifies what a retired key signed', async () => {
    // Rotation cannot mean rehashing: the table rejects UPDATE and a chain
    // configuration can rewrite is not a chain. So the old key is kept for
    // verification and the new one signs from now on (ADR 0030).
    const events = new MemoryEvents();
    await appendThree(new EventLedger({ key: otherKey, events }));

    const rotated = new EventLedger({ key: keyring(key, [otherKey]), events });
    const before = await rotated.verify(ws);
    // Green, and it says the green depended on a key the operator might drop.
    expect(before).toMatchObject({ ok: true, count: 3, usedRetiredKey: true });

    // And what is written from here on is signed with the new one.
    await rotated.append(
      tx,
      ws,
      { actorId: 'act_1' as ActorId, requestId: 'req' },
      { eventType: 'workspace.updated', objectType: 'workspace', objectId: ws },
    );
    const after = await rotated.verify(ws);
    expect(after).toMatchObject({ ok: true, count: 4, usedRetiredKey: true });
    // Only the new key: the three the old one signed stop verifying, which is the
    // consequence of dropping a retired key rather than a defect.
    const dropped = await new EventLedger({ key, events }).verify(ws);
    expect(dropped).toMatchObject({ ok: false, brokenAt: 1 });

    // And a workspace that starts after the rotation needs only the new key —
    // which is what says the retired one verifies and never signs.
    const fresh = 'ws_01J8Z3M4Q9V0X7K2B5N6P8R1TF' as WorkspaceId;
    await rotated.append(
      tx,
      fresh,
      { actorId: 'act_1' as ActorId, requestId: 'req' },
      { eventType: 'workspace.created', objectType: 'workspace', objectId: fresh },
    );
    await expect(new EventLedger({ key, events }).verify(fresh)).resolves.toMatchObject({
      ok: true,
      count: 1,
    });
  });

  it('still verifies when a key is put back as the signing one', async () => {
    // A rotation an operator undid: the chain starts under the key that signs
    // again, and the events in the middle were signed by the one now retired. The
    // genesis says nothing about them, so each event is checked against the ring.
    const events = new MemoryEvents();
    await appendThree(new EventLedger({ key, events }));
    const rotated = new EventLedger({ key: keyring(otherKey, [key]), events });
    await rotated.append(
      tx,
      ws,
      { actorId: 'act_1' as ActorId, requestId: 'req' },
      { eventType: 'workspace.updated', objectType: 'workspace', objectId: ws },
    );

    const reverted = new EventLedger({ key: keyring(key, [otherKey]), events });
    const result = await reverted.verify(ws);
    expect(result).toMatchObject({ ok: true, count: 4, usedRetiredKey: true });
  });

  it('names a key without being one', () => {
    // An operator checking which key is running should not have to print it.
    expect(fingerprint(key)).toHaveLength(16);
    expect(fingerprint(key)).not.toBe(fingerprint(otherKey));
    expect(fingerprint(key)).not.toContain(key.bytes.toString('hex').slice(0, 8));
  });

  it('keeps a separate chain per workspace', async () => {
    const events = new MemoryEvents();
    const ledger = ledgerWith(events);
    const other = 'ws_01J8Z3M4Q9V0X7K2B5N6P8R1T4' as WorkspaceId;
    await appendThree(ledger);
    await ledger.append(
      tx,
      other,
      { actorId: 'act_1' as ActorId, requestId: 'req' },
      {
        eventType: 'workspace.created',
        objectType: 'workspace',
        objectId: other,
      },
    );
    const first = events.rows.find((r) => r.workspaceId === other)!;
    expect(first.sequence).toBe(1);
    expect(first.prevEventHash).toBe(genesisHash(key));
    await expect(ledger.verify(ws)).resolves.toEqual({ ok: true, count: 3 });
    await expect(ledger.verify(other)).resolves.toEqual({ ok: true, count: 1 });
  });

  it('detects two events swapped in place', async () => {
    const events = new MemoryEvents();
    const ledger = ledgerWith(events);
    await appendThree(ledger);
    const [a, b] = [events.rows[1]!, events.rows[2]!];
    // Swap the payloads but keep the sequence numbers, so only the chain can tell.
    events.rows[1] = { ...b, sequence: a.sequence };
    events.rows[2] = { ...a, sequence: b.sequence };
    expect(await ledger.verify(ws)).toMatchObject({ ok: false, brokenAt: 2 });
  });

  it('detects a deleted event', async () => {
    const events = new MemoryEvents();
    const ledger = ledgerWith(events);
    await appendThree(ledger);
    events.rows.splice(1, 1);
    expect(await ledger.verify(ws)).toMatchObject({
      ok: false,
      brokenAt: 3,
      reason: 'sequence gap',
    });
  });

  it('hashes the canonical record so key order does not matter', () => {
    const prev = genesisHash(key);
    expect(computeEventHash(key, prev, { a: 1, b: 2 })).toBe(
      computeEventHash(key, prev, { b: 2, a: 1 }),
    );
    expect(computeEventHash(key, prev, { a: 1 })).not.toBe(
      computeEventHash(otherKey, prev, { a: 1 }),
    );
  });
});
