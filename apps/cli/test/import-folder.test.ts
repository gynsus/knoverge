import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { AgentId, WorkspaceId } from '@knoverge/contracts';
import type { ActorContext } from '@knoverge/core';
import {
  AgentService,
  AuthorizationService,
  CrossStoreWriter,
  EventLedger,
  KnowledgeService,
  SyncService,
  WorkspaceService,
  keyring,
  parseLedgerKey,
} from '@knoverge/core';
import { generateOpaqueToken, hashToken } from '@knoverge/auth';
import {
  contentHash,
  createGitStore,
  frontmatterHash,
  parseItem,
  renderItem,
  slugifyTitle,
  uniqueSlug,
} from '@knoverge/git-store';
import {
  createDatabase,
  createRepositories,
  createUnitOfWork,
  runMigrations,
  type DatabaseHandle,
} from '@knoverge/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { importFolder } from '../src/import-folder.ts';
import type { Services } from '../src/run.ts';

const migrationsFolder = fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url));

let container: StartedPostgreSqlContainer;
let handle: DatabaseHandle;
let services: Services;
let dataDir: string;
let folder: string;
let workspaceId: WorkspaceId;
let agentId: AgentId;

/** The note the workspace already holds, word for word. */
const KNOWN = '# Escalation path\n\nSupport first, then the on-call engineer.\n';

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  handle = createDatabase({ connectionString: container.getConnectionUri(), max: 6 });
  handle.pool.on('error', () => undefined);
  await runMigrations(handle.db, migrationsFolder);

  dataDir = await mkdtemp(join(tmpdir(), 'knoverge-folder-data-'));
  folder = await mkdtemp(join(tmpdir(), 'knoverge-folder-'));
  const repositories = createRepositories(handle.db);
  const uow = createUnitOfWork(handle.db);
  const ledger = new EventLedger({
    key: keyring(parseLedgerKey('a1'.repeat(32))),
    events: repositories.events,
  });
  const git = createGitStore({ dataDir });

  const workspaces = new WorkspaceService({
    uow,
    workspaces: repositories.workspaces,
    actors: repositories.actors,
    ledger,
  });
  const workspace = await workspaces.create({
    slug: 'personal',
    name: 'Personal',
    requestId: 'req-setup',
  });
  workspaceId = workspace.id;
  const system = (await repositories.actors.findSystemActor(workspaceId))!;
  const actor = {
    workspaceId,
    actorId: system.id,
    actorType: 'system',
    requestId: 'req-setup',
    client: 'test-suite',
  } as ActorContext;

  const crossStore = new CrossStoreWriter({
    uow,
    operations: repositories.operations,
    commitExists: (ws, operationId) => git.hasCommitForOperation(ws, operationId),
  });
  const knowledge = new KnowledgeService({
    uow,
    items: repositories.knowledge,
    revisions: repositories.revisions,
    sources: repositories.sources,
    relations: repositories.relations,
    summaries: repositories.summaries,
    search: repositories.search,
    categories: repositories.categories,
    versions: repositories.taxonomyVersions,
    actors: repositories.actors,
    workspaces: {
      findById: async (id: WorkspaceId) => {
        const found = await repositories.workspaces.findById(id);
        return found
          ? { id: found.id, name: found.name, defaultLanguage: found.defaultLanguage }
          : null;
      },
    },
    ledger,
    crossStore,
    git,
    slugifyTitle,
    uniqueSlug,
    renderItem,
    parseItem,
    contentHash,
    frontmatterHash,
  });
  // The note the folder will turn out to contain a copy of, written the way
  // this product writes one: a heading, then the text.
  await knowledge.create(actor, {
    title: 'Escalation path',
    body: 'Support first, then the on-call engineer.',
    type: 'document',
  });

  const authorization = new AuthorizationService({
    uow,
    grants: repositories.grants,
    rules: repositories.policyRules,
    categories: repositories.categories,
    workspaces: repositories.workspaces,
    ledger,
  });
  const agents = new AgentService({
    uow,
    agents: repositories.agents,
    credentials: repositories.credentials,
    actors: repositories.actors,
    ledger,
    tokens: { generate: generateOpaqueToken, hash: (token) => hashToken(token, 'b2'.repeat(32)) },
    authorization,
  });
  const agent = await agents.create(actor, { role: 'owner' }, { name: 'The folder importer' });
  agentId = agent.id;

  services = {
    repositories,
    uow,
    sync: new SyncService({
      uow,
      sync: repositories.sync,
      items: repositories.knowledge,
      categories: repositories.categories,
      workspaces: repositories.workspaces,
      nearest: async () => [],
    }),
  } as unknown as Services;

  // The folder: one note the workspace already has, one it does not, and one
  // in a subdirectory.
  await writeFile(join(folder, 'escalation.md'), KNOWN, 'utf8');
  await writeFile(join(folder, 'rota.md'), '# Rota\n\nWho is on call this week.\n', 'utf8');
  await mkdir(join(folder, 'Pixel Brisbane'), { recursive: true });
  await writeFile(
    join(folder, 'Pixel Brisbane', 'auth.md'),
    '---\ntitle: Authentication\n---\n\nPasswordless, with a six-digit code.\n',
    'utf8',
  );
  // And the things a folder has that are not notes.
  await mkdir(join(folder, '.obsidian'), { recursive: true });
  await writeFile(join(folder, '.obsidian', 'workspace.json'), '{}', 'utf8');
  await writeFile(join(folder, 'photo.png'), 'not a note', 'utf8');
}, 240_000);

afterAll(async () => {
  await handle?.close().catch(() => undefined);
  await container?.stop();
  for (const dir of [dataDir, folder]) if (dir) await rm(dir, { recursive: true, force: true });
});

describe('knoverge import-folder', () => {
  it('reads the notes and nothing else, and writes no knowledge', async () => {
    const before = await services.repositories.knowledge.countFor(workspaceId);
    const result = await importFolder(services, {
      workspaceId,
      agentId,
      from: folder,
      sourceSystem: 'markdown-folder',
      namespace: 'test-vault',
      requestId: 'req-import',
    });

    // Three notes: a tool's own state and a photograph are not.
    expect(result.read).toBe(3);
    expect(result.submitted).toBe(3);
    // An inventory is a question. Nothing is written until somebody decides
    // what to propose (ADR 0036).
    expect(await services.repositories.knowledge.countFor(workspaceId)).toBe(before);
  });

  it('says which of them the workspace already holds', async () => {
    const result = await importFolder(services, {
      workspaceId,
      agentId,
      from: folder,
      sourceSystem: 'markdown-folder',
      namespace: 'second-run',
      requestId: 'req-import-2',
    });
    // The note that matches word for word is known; the other two are new.
    // This is the whole reason an importer is a session rather than an insert.
    expect(result.classifications['exact_known']).toBe(1);
    expect(result.classifications['new_candidate']).toBe(2);
  });

  it('keys a candidate by its path, so a second run is not a second copy', async () => {
    const first = await importFolder(services, {
      workspaceId,
      agentId,
      from: folder,
      sourceSystem: 'markdown-folder',
      namespace: 'repeatable',
      requestId: 'req-a',
    });
    const again = await importFolder(services, {
      workspaceId,
      agentId,
      from: folder,
      sourceSystem: 'markdown-folder',
      namespace: 'repeatable',
      requestId: 'req-b',
    });
    // A folder pointed at twice is classified twice and inserted once.
    expect(again.read).toBe(first.read);
    const candidates = await services.repositories.sync.listCandidates(again.sessionId, {
      limit: 50,
    });
    expect(candidates.map((candidate) => candidate.clientCandidateId).sort()).toEqual([
      'Pixel Brisbane/auth.md',
      'escalation.md',
      'rota.md',
    ]);
  });

  it('arrives as the agent it was told to be', async () => {
    const result = await importFolder(services, {
      workspaceId,
      agentId,
      from: folder,
      sourceSystem: 'markdown-folder',
      namespace: 'whose-session',
      requestId: 'req-whose',
    });
    const session = await services.repositories.sync.findSession(workspaceId, result.sessionId);
    // An importer is an agent, so the policy that decides what its writing
    // becomes is the one already configured for that agent (ADR 0036).
    expect(session?.agentId).toBe(agentId);
  });
});
