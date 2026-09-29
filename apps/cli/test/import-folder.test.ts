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
  DuplicateMatcher,
  EventLedger,
  KnowledgeService,
  ProposalService,
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
import { importJson } from '../src/import-json.ts';
import { proposeFromSession } from '../src/propose-from-session.ts';
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
    proposals: new ProposalService({
      uow,
      proposals: repositories.proposals,
      knowledge,
      knowledgeIndex: repositories.knowledge,
      categories: repositories.categories,
      authorization,
      duplicates: new DuplicateMatcher({
        items: repositories.knowledge,
        contentHash,
        nearest: async () => [],
      }),
      actors: repositories.actors,
      ledger,
    }),
  } as unknown as Services;

  // The folder: one note the workspace already has, one it does not, and one
  // in a subdirectory.
  await writeFile(join(folder, 'escalation.md'), KNOWN, 'utf8');
  await writeFile(join(folder, 'rota.md'), '# Rota\n\nWho is on call this week.\n', 'utf8');
  await mkdir(join(folder, 'Pixel Brisbane'), { recursive: true });
  await writeFile(
    join(folder, 'Pixel Brisbane', 'auth.md'),
    '---\ntitle: Authentication\ntags: [security, login]\n---\n\nPasswordless, with a six-digit code. See #auth.\n',
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

describe('knoverge import-json', () => {
  it('offers the records it can read and says what it left out', async () => {
    const file = join(folder, '..', 'export.json');
    await writeFile(
      file,
      JSON.stringify({
        pages: [
          // The note the workspace already holds, word for word.
          {
            id: 'page-1',
            title: 'Escalation path',
            body: 'Support first, then the on-call engineer.',
          },
          { id: 'page-2', title: 'Something new', body: 'Nobody has said this before.' },
          { id: 'page-3', title: 'No body here' },
        ],
      }),
      'utf8',
    );
    try {
      const result = await importJson(services, {
        workspaceId,
        agentId,
        file,
        sourceSystem: 'json-export',
        namespace: 'a-notion-export',
        requestId: 'req-json',
      });

      expect(result.read).toBe(2);
      expect(result.skipped).toBe(1);
      // The same three steps as a folder, because the shape is the shape: the
      // workspace answers which of these it already has.
      expect(result.classifications['exact_known']).toBe(1);
      expect(result.classifications['new_candidate']).toBe(1);
    } finally {
      await rm(file, { force: true });
    }
  });

  it('refuses a file that is not JSON, by name', async () => {
    const file = join(folder, '..', 'broken.json');
    await writeFile(file, '{ not json', 'utf8');
    try {
      await expect(
        importJson(services, {
          workspaceId,
          agentId,
          file,
          sourceSystem: 'json-export',
          namespace: 'broken',
          requestId: 'req-json-2',
        }),
      ).rejects.toThrow(/is not JSON this can read/u);
    } finally {
      await rm(file, { force: true });
    }
  });
});

describe('knoverge propose-from-session', () => {
  it('proposes the new ones, leaves the known one alone, and writes nothing yet', async () => {
    const session = await importFolder(services, {
      workspaceId,
      agentId,
      from: folder,
      sourceSystem: 'markdown-folder',
      namespace: 'to-propose',
      requestId: 'req-inventory',
    });

    const result = await proposeFromSession(services, {
      workspaceId,
      sessionId: session.sessionId,
      from: folder,
      requestId: 'req-propose',
    });

    // The two the workspace did not recognise become proposals; the one it
    // already holds is left alone with the reason it was left alone.
    expect(result.proposed).toBe(2);
    // An agent proposes by default: rule 14 says a write waits for review
    // unless a rule says otherwise, and no rule does here.
    expect(result.written).toBe(0);
    expect(result.skipped).toEqual([{ path: 'escalation.md', why: 'exact_known' }]);

    // And they are in the queue, as an agent's writing is.
    const pending = await services.repositories.proposals.list(workspaceId, { limit: 50 });
    expect(pending.filter((proposal) => proposal.status === 'pending')).toHaveLength(2);
  });

  it('sends the same text the fingerprint was taken of', async () => {
    const session = await importFolder(services, {
      workspaceId,
      agentId,
      from: folder,
      sourceSystem: 'markdown-folder',
      namespace: 'same-text',
      requestId: 'req-inventory-2',
    });
    await proposeFromSession(services, {
      workspaceId,
      sessionId: session.sessionId,
      from: folder,
      requestId: 'req-propose-2',
    });

    const proposals = await services.repositories.proposals.list(workspaceId, { limit: 50 });
    const rota = proposals.find(
      (proposal) => (proposal.proposedPayload as { title?: string }).title === 'Rota',
    );
    // The heading that was the title is not in the body twice, and the body is
    // what the parser said it was — not a second reading of the same file.
    expect((rota?.proposedPayload as { body?: string }).body).toBe('Who is on call this week.\n');
  });

  it('refuses to propose a file that changed since the session was taken', async () => {
    const session = await importFolder(services, {
      workspaceId,
      agentId,
      from: folder,
      sourceSystem: 'markdown-folder',
      namespace: 'moved-on',
      requestId: 'req-inventory-3',
    });
    await writeFile(join(folder, 'rota.md'), '# Rota\n\nSomebody else this week.\n', 'utf8');
    try {
      const result = await proposeFromSession(services, {
        workspaceId,
        sessionId: session.sessionId,
        from: folder,
        requestId: 'req-propose-3',
      });
      // Proposing text the workspace never classified would make the session a
      // record of something that did not happen.
      expect(result.skipped).toContainEqual({
        path: 'rota.md',
        why: 'the file changed since the session was taken; run the importer again',
      });
    } finally {
      await writeFile(join(folder, 'rota.md'), '# Rota\n\nWho is on call this week.\n', 'utf8');
    }
  });

  it('carries the tags the note was written with', async () => {
    const session = await importFolder(services, {
      workspaceId,
      agentId,
      from: folder,
      sourceSystem: 'markdown-folder',
      namespace: 'with-tags',
      requestId: 'req-inventory-5',
    });
    await proposeFromSession(services, {
      workspaceId,
      sessionId: session.sessionId,
      from: folder,
      requestId: 'req-propose-5',
    });

    const proposals = await services.repositories.proposals.list(workspaceId, { limit: 50 });
    const auth = proposals.find(
      (proposal) => (proposal.proposedPayload as { title?: string }).title === 'Authentication',
    );
    // Both places a person writes a tag: the frontmatter list and the `#tag` in
    // the text. A tag is part of the note, even though it is no part of an
    // inventory — what a note is tagged does not help decide whether the
    // workspace already holds it.
    expect((auth?.proposedPayload as { tags?: string[] }).tags?.sort()).toEqual([
      'auth',
      'login',
      'security',
    ]);
  });

  it('proposes without a category the taxonomy does not have', async () => {
    const session = await importFolder(services, {
      workspaceId,
      agentId,
      from: folder,
      sourceSystem: 'markdown-folder',
      namespace: 'no-such-category',
      requestId: 'req-inventory-4',
    });
    const result = await proposeFromSession(services, {
      workspaceId,
      sessionId: session.sessionId,
      from: folder,
      requestId: 'req-propose-4',
    });
    // `Pixel Brisbane/auth.md` suggests a category this workspace has never
    // had. The folder structure is a suggestion, and creating categories is a
    // separate decision with its own review — so the note arrives without one
    // rather than being refused.
    expect(result.proposed).toBeGreaterThan(0);
    const proposals = await services.repositories.proposals.list(workspaceId, { limit: 50 });
    const auth = proposals.find(
      (proposal) => (proposal.proposedPayload as { title?: string }).title === 'Authentication',
    );
    expect((auth?.proposedPayload as { categories?: string[] }).categories ?? []).toEqual([]);
  });
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
