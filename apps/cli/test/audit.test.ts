import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { ActorId, AgentId, WorkspaceId } from '@knoverge/contracts';
import {
  EventLedger,
  exportHeader,
  exportedEvent,
  keyring,
  parseLedgerKey,
  verifyExport,
  type ExportHeader,
  type ExportedEvent,
} from '@knoverge/core';
import {
  createDatabase,
  createRepositories,
  createUnitOfWork,
  runMigrations,
  type DatabaseHandle,
} from '@knoverge/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const migrationsFolder = fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url));
const key = parseLedgerKey('ab'.repeat(32));
const keys = keyring(key);

let container: StartedPostgreSqlContainer;
let handle: DatabaseHandle;
let repositories: ReturnType<typeof createRepositories>;
let uow: ReturnType<typeof createUnitOfWork>;
let ledger: EventLedger;
let workspaceId: WorkspaceId;
let actorId: ActorId;
let dir: string;

/** The export as the command writes it, without going through the command. */
async function exportTo(after = 0): Promise<{ header: ExportHeader; events: ExportedEvent[] }> {
  const latest = await repositories.events.latestSequence(workspaceId);
  const header = exportHeader(
    workspaceId,
    keys,
    { from: after + 1, to: latest, events: Math.max(0, latest - after) },
    new Date(),
  );
  const rows = await repositories.events.listAfter(workspaceId, after, 500);
  return { header, events: rows.map(exportedEvent) };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  handle = createDatabase({ connectionString: container.getConnectionUri(), max: 4 });
  handle.pool.on('error', () => undefined);
  await runMigrations(handle.db, migrationsFolder);
  repositories = createRepositories(handle.db);
  uow = createUnitOfWork(handle.db);
  ledger = new EventLedger({ key: keys, events: repositories.events });
  dir = await mkdtemp(join(tmpdir(), 'knoverge-audit-'));

  workspaceId = 'ws_01M3H4Z00000000000000000AU' as WorkspaceId;
  const now = new Date('2026-09-20T00:00:00Z');
  await uow.run(async (tx) => {
    await repositories.workspaces.insert(tx, {
      id: workspaceId,
      slug: 'personal',
      name: 'Personal',
      description: null,
      defaultLanguage: 'en',
      settings: {},
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    });
    await repositories.actors.insert(tx, {
      id: 'act_01M3H4Z00000000000000000AU' as ActorId,
      workspaceId,
      type: 'system',
      displayName: 'System',
      userId: null,
      agentId: null,
      disabledAt: null,
      createdAt: now,
    });
  });
  actorId = 'act_01M3H4Z00000000000000000AU' as ActorId;

  for (let i = 0; i < 5; i += 1) {
    await uow.run((tx) =>
      ledger.append(
        tx,
        workspaceId,
        {
          actorId,
          requestId: `req_${i}`,
          sessionId: `sess_${i}`,
          client: 'claude-code',
          provider: 'ollama',
          model: 'llama3.1',
          agentId: `ag_01M3H4Z0000000000000000G${i}` as AgentId,
        },
        {
          eventType: 'workspace.updated',
          objectType: 'workspace',
          objectId: workspaceId,
          // Something in every field the hash covers, so an export that drops one
          // is an export that fails to verify rather than one that happens to
          // match because the field was empty either way.
          categoryIds: [`cat_01M3H4Z0000000000000000C${i}`],
          beforeRevisionId: `rev_01M3H4Z0000000000000000B${i}`,
          beforeContentHash: `sha256:before${i}`,
          afterRevisionId: `rev_01M3H4Z0000000000000000A${i}`,
          afterContentHash: `sha256:after${i}`,
          proposalId: `prop_01M3H4Z000000000000000P${i}`,
          metadata: { round: i },
        },
      ),
    );
  }
});

afterAll(async () => {
  await handle?.close().catch(() => undefined);
  await container?.stop();
  if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('knoverge audit export', () => {
  it('writes what it takes to check it without the installation', async () => {
    const { header, events } = await exportTo();
    expect(header).toMatchObject({
      knoverge_export: 'audit',
      version: 1,
      workspace_id: workspaceId,
      from_sequence: 1,
      to_sequence: 5,
      events: 5,
    });
    // The fingerprint says which key to bring; the key itself is not in the file.
    expect(header.key_fingerprints).toHaveLength(1);
    expect(JSON.stringify(header)).not.toContain(key.bytes.toString('hex'));
    // And the chain holds, computed from the file and the key alone.
    expect(verifyExport(keys, header, events)).toEqual({ ok: true, count: 5 });
    // What was signed, under the names the hasher uses: category ids and not
    // paths, because a path is a name that can change and an id cannot.
    expect(Object.keys(events[0] ?? {})).toContain('category_ids');
    expect(Object.keys(events[0] ?? {})).toContain('prev_event_hash');
  });

  it('says where a tampered line stops holding together', async () => {
    const { header, events } = await exportTo();
    const edited = events.map((event, index) =>
      index === 2 ? { ...event, object_id: 'ws_01M3H4Z0000000000000000TAM' } : event,
    );
    expect(verifyExport(keys, header, edited)).toMatchObject({
      ok: false,
      brokenAt: 3,
      reason: 'event hash mismatch',
    });
  });

  it('notices a line somebody removed', async () => {
    const { header, events } = await exportTo();
    const short = events.filter((event) => event.sequence !== 3);
    // A gapless sequence is what makes a removal visible: the chain would also
    // break, and this says which is missing rather than which is wrong.
    expect(verifyExport(keys, header, short)).toMatchObject({ ok: false, reason: 'sequence gap' });
  });

  it('verifies a slice that starts part way along', async () => {
    const { header, events } = await exportTo(2);
    expect(header.from_sequence).toBe(3);
    expect(events.map((event) => event.sequence)).toEqual([3, 4, 5]);
    // Nothing before the first line is in the file, so the walk starts where the
    // file does; the links inside it still have to hold.
    expect(verifyExport(keys, header, events)).toEqual({ ok: true, count: 3 });
  });

  it('refuses a file signed by a key nobody brought', async () => {
    const { header, events } = await exportTo();
    const stranger = keyring(parseLedgerKey('cd'.repeat(32)));
    expect(verifyExport(stranger, header, events)).toMatchObject({ ok: false, brokenAt: 1 });
  });

  it('is readable as JSON lines, one event per line', async () => {
    // The format an operator pipes into something else. Written here the way the
    // command writes it, so the test reads a file rather than an array.
    const { header, events } = await exportTo();
    const path = join(dir, 'audit.jsonl');
    await rm(path, { force: true });
    const body = [header, ...events].map((line) => JSON.stringify(line)).join('\n') + '\n';
    await (await import('node:fs/promises')).writeFile(path, body, 'utf8');

    const lines = (await readFile(path, 'utf8')).split('\n').filter((l) => l !== '');
    expect(lines).toHaveLength(6);
    const readBack = lines.map((line) => JSON.parse(line) as unknown);
    expect((readBack[0] as ExportHeader).knoverge_export).toBe('audit');
    expect(
      verifyExport(keys, readBack[0] as ExportHeader, readBack.slice(1) as ExportedEvent[]),
    ).toEqual({ ok: true, count: 5 });
  });
});
