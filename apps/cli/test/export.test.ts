import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { ActorId, AttachmentId, WorkspaceId } from '@knoverge/contracts';
import { FileAttachmentStore } from '@knoverge/attachments';
import { ExportService } from '@knoverge/core';
import {
  createDatabase,
  createRepositories,
  createUnitOfWork,
  runMigrations,
  type DatabaseHandle,
} from '@knoverge/db';
import { createGitStore, repositoryPath } from '@knoverge/git-store';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { takeExport } from '../src/export.ts';
import type { Services } from '../src/run.ts';

const run = promisify(execFile);
const migrationsFolder = fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url));

let container: StartedPostgreSqlContainer;
let handle: DatabaseHandle;
let services: Services;
let dataDir: string;
let into: string;
let store: FileAttachmentStore;

const workspaceId = 'ws_01M3H4Z00000000000000000EX' as WorkspaceId;
const actorId = 'act_01M3H4Z00000000000000000EX' as ActorId;
const attachmentId = 'att_01M3H4Z00000000000000000EX' as AttachmentId;
const ITEM = `---
id: kn_01M3H4Z00000000000000000EX
title: Escalation path
type: procedure
status: active
language: en
created_at: 2026-09-20T00:00:00Z
updated_at: 2026-09-20T00:00:00Z
---

Support first, then the on-call engineer.
`;

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  handle = createDatabase({ connectionString: container.getConnectionUri(), max: 6 });
  handle.pool.on('error', () => undefined);
  await runMigrations(handle.db, migrationsFolder);

  dataDir = await mkdtemp(join(tmpdir(), 'knoverge-export-data-'));
  into = await mkdtemp(join(tmpdir(), 'knoverge-export-out-'));
  store = new FileAttachmentStore(dataDir);

  const repositories = createRepositories(handle.db);
  const uow = createUnitOfWork(handle.db);
  const git = createGitStore({ dataDir });
  services = {
    repositories,
    uow,
    git,
    attachmentStore: store,
    exports: new ExportService({
      workspaces: repositories.workspaces,
      actors: repositories.actors,
      knowledge: repositories.knowledge,
      attachments: repositories.attachments,
      events: repositories.events,
    }),
  } as unknown as Services;

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
      id: actorId,
      workspaceId,
      type: 'human',
      displayName: 'Grigory Frolov',
      userId: null,
      agentId: null,
      createdAt: now,
      disabledAt: null,
    });
  });

  // A real repository with a real commit, because a bundle of a repository with
  // no refs is what git refuses, and an export of one would be an empty file.
  await git.ensureRepository(
    workspaceId,
    'Personal',
    { name: 'Grigory Frolov', email: 'owner@example.com' },
    now,
  );
  await git.write(workspaceId, [
    { path: 'knowledge/_uncategorised/escalation-path.md', content: ITEM },
  ]);
  await git.commit(workspaceId, {
    paths: ['knowledge/_uncategorised/escalation-path.md'],
    subject: 'create(procedure): Escalation path',
    trailers: [
      ['Knoverge-Workspace', workspaceId],
      ['Knoverge-Actor', actorId],
      ['Knoverge-Change', 'kn_01M3H4Z00000000000000000EX@rev_01M3H4Z00000000000000000EX create'],
    ],
    author: { name: 'Grigory Frolov', email: 'owner@example.com' },
    at: now,
  });

  const bytes = Buffer.from('Support closes at five.\n');
  const put = await store.put(workspaceId, bytes);
  await uow.run((tx) =>
    repositories.attachments.insert(tx, {
      id: attachmentId,
      workspaceId,
      contentHash: put.hash,
      mediaType: 'text/plain',
      sizeBytes: put.size,
      filename: 'hours.txt',
      originalUri: null,
      extractionState: 'extracted',
      extractionError: null,
      extractionStartedAt: null,
      uploadedByActorId: actorId,
      createdAt: now,
    }),
  );
}, 180_000);

afterAll(async () => {
  await handle?.close().catch(() => undefined);
  await container?.stop();
  for (const dir of [dataDir, into]) if (dir) await rm(dir, { recursive: true, force: true });
});

describe('knoverge export', () => {
  it('writes a bundle a plain git can open, and nothing half written', async () => {
    const result = await takeExport(services, {
      workspaceId,
      into,
      withAttachments: false,
      now: new Date('2026-09-29T10:00:00Z'),
    });

    expect(result.path).toBe(join(into, `20260929T100000Z-${workspaceId}`));
    expect((await readdir(result.path)).sort()).toEqual([
      'README.md',
      'manifest.json',
      'repository.bundle',
    ]);
    // Nothing left beside it: a `.partial` directory is what a run that died
    // leaves, and an import must not be able to mistake one for an export.
    expect((await readdir(into)).filter((name) => name.endsWith('.partial'))).toEqual([]);

    // The promise the whole format rests on: git and nothing else.
    const clone = join(into, 'clone');
    await run('git', ['clone', '--quiet', join(result.path, 'repository.bundle'), clone]);
    expect(await readFile(join(clone, 'knowledge/_uncategorised/escalation-path.md'), 'utf8')).toBe(
      ITEM,
    );
    // And the history with it, trailers included — which is what an import reads
    // to know which item and which revision each commit was.
    const log = await run('git', ['-C', clone, 'log', '--format=%B']);
    expect(log.stdout).toContain('Knoverge-Change: kn_01M3H4Z00000000000000000EX@');
    await rm(clone, { recursive: true, force: true });
  });

  it('carries every ref, not only the branch that happens to be checked out', async () => {
    // A repository that ever had another branch must not quietly lose it: the
    // bundle is the whole repository or it is a partial copy pretending to be one.
    const repository = repositoryPath(dataDir, workspaceId);
    await run('git', ['-C', repository, 'branch', 'spare']);
    try {
      const result = await takeExport(services, {
        workspaceId,
        into,
        withAttachments: false,
        now: new Date('2026-09-29T10:30:00Z'),
      });
      const listed = await run('git', [
        'bundle',
        'list-heads',
        join(result.path, 'repository.bundle'),
      ]);
      expect(listed.stdout).toContain('refs/heads/spare');
    } finally {
      await run('git', ['-C', repository, 'branch', '-D', 'spare']);
    }
  });

  it('says what the files cannot, and carries nobody’s address', async () => {
    const result = await takeExport(services, {
      workspaceId,
      into,
      withAttachments: false,
      now: new Date('2026-09-29T11:00:00Z'),
    });
    const manifest = JSON.parse(
      await readFile(join(result.path, 'manifest.json'), 'utf8'),
    ) as Record<string, never>;

    expect(manifest).toMatchObject({
      format: 'knoverge-workspace-export',
      format_version: 1,
      taken_by: 'knoverge export',
      workspace: { slug: 'personal', name: 'Personal', default_language: 'en' },
      ledger_sequence: 0,
    });
    // Who a commit trailer names, so an import can say "Grigory Frolov" where
    // the commit says act_01…
    expect(manifest['actors']).toEqual([
      { id: actorId, type: 'human', display_name: 'Grigory Frolov' },
    ]);
    // An export is meant to be handed to somebody: no addresses, no secrets.
    expect(JSON.stringify(manifest)).not.toContain('@example.com');

    // Every file the workspace holds is named whether or not its bytes came
    // along, so an import can say what is missing rather than finding out later.
    expect(manifest['attachments']).toEqual([
      {
        id: attachmentId,
        filename: 'hours.txt',
        media_type: 'text/plain',
        size_bytes: 24,
        content_hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u) as unknown,
        included: false,
      },
    ]);
  });

  it('carries the files when asked, under the hash the store keeps them by', async () => {
    const result = await takeExport(services, {
      workspaceId,
      into,
      withAttachments: true,
      now: new Date('2026-09-29T12:00:00Z'),
    });

    expect(result.attachments).toEqual({ copied: 1, missing: [] });
    const manifest = JSON.parse(await readFile(join(result.path, 'manifest.json'), 'utf8')) as {
      attachments: { content_hash: string; included: boolean }[];
    };
    const hash = manifest.attachments[0]!.content_hash.replace('sha256:', '');
    expect(manifest.attachments[0]!.included).toBe(true);
    // By content and not by filename: an import puts the bytes back the way the
    // store keeps them, and a filename is what an uploader called it (ADR 0008).
    expect(await readFile(join(result.path, 'attachments', hash), 'utf8')).toBe(
      'Support closes at five.\n',
    );
  });

  it('names a file the store does not hold instead of claiming it was carried', async () => {
    const orphan = 'att_01M3H4Z00000000000000000OR' as AttachmentId;
    await services.uow.run((tx) =>
      services.repositories.attachments.insert(tx, {
        id: orphan,
        workspaceId,
        contentHash: `sha256:${'b'.repeat(64)}`,
        mediaType: 'application/pdf',
        sizeBytes: 12,
        filename: 'gone.pdf',
        originalUri: null,
        extractionState: 'extracted',
        extractionError: null,
        extractionStartedAt: null,
        uploadedByActorId: actorId,
        createdAt: new Date('2026-09-20T00:00:00Z'),
      }),
    );

    const result = await takeExport(services, {
      workspaceId,
      into,
      withAttachments: true,
      now: new Date('2026-09-29T13:00:00Z'),
    });

    // An attachment is not in Git and cannot be rebuilt from anything, so a row
    // whose file is gone is the unrepairable kind. The manifest says so rather
    // than promising bytes that are not in the directory.
    expect(result.attachments.missing).toEqual([orphan]);
    const manifest = JSON.parse(await readFile(join(result.path, 'manifest.json'), 'utf8')) as {
      attachments: { id: string; included: boolean }[];
    };
    expect(manifest.attachments.find((a) => a.id === orphan)?.included).toBe(false);
    expect(manifest.attachments.find((a) => a.id === attachmentId)?.included).toBe(true);
  });
});
