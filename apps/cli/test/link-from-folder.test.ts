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

import { linkFromFolder } from '../src/link-from-folder.ts';
import type { Services } from '../src/run.ts';

const migrationsFolder = fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url));

let container: StartedPostgreSqlContainer;
let handle: DatabaseHandle;
let services: Services;
let dataDir: string;
let folder: string;
let workspaceId: WorkspaceId;
let agentId: AgentId;
let escalationId: string;
let rotaId: string;
let selfishId: string;
let settledId: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  handle = createDatabase({ connectionString: container.getConnectionUri(), max: 6 });
  handle.pool.on('error', () => undefined);
  await runMigrations(handle.db, migrationsFolder);

  dataDir = await mkdtemp(join(tmpdir(), 'knoverge-link-data-'));
  folder = await mkdtemp(join(tmpdir(), 'knoverge-link-'));
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
  const actor = {
    workspaceId,
    actorId: (await repositories.actors.findSystemActor(workspaceId))!.id,
    actorType: 'system',
    requestId: 'req-setup',
    client: 'test-suite',
  } as ActorContext;

  const crossStore = new CrossStoreWriter({
    uow,
    operations: repositories.operations,
    commitExists: (ws, operationId) => git.hasCommitForOperation(ws, operationId),
  });
  const lookup = {
    findById: async (id: WorkspaceId) => {
      const found = await repositories.workspaces.findById(id);
      return found
        ? { id: found.id, name: found.name, defaultLanguage: found.defaultLanguage }
        : null;
    },
  };
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
    workspaces: lookup,
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
  agentId = (await agents.create(actor, { role: 'owner' }, { name: 'The linker' })).id;

  services = {
    repositories,
    uow,
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

  // The notes, and the items they were imported as: two that point at each
  // other, one that points at nothing that exists, and one that was never
  // accepted so is not an item at all.
  await writeFile(
    join(folder, 'escalation.md'),
    '# Escalation path\n\nSupport first. See [[rota]].\n',
    'utf8',
  );
  await writeFile(
    join(folder, 'rota.md'),
    '# Rota\n\nWho is on call. See [[escalation]] and [[Nothing at all]].\n',
    'utf8',
  );
  await writeFile(join(folder, 'orphan.md'), '# Orphan\n\nNot accepted. See [[rota]].\n', 'utf8');
  // A note that links to itself, which people do when they rename things.
  await writeFile(join(folder, 'selfish.md'), '# Selfish\n\nSee [[selfish]].\n', 'utf8');
  // And one whose item already carries the relation the link describes.
  await writeFile(join(folder, 'settled.md'), '# Settled\n\nSee [[rota]].\n', 'utf8');
  // Two notes with the same name in different folders, which is what makes a
  // bare name ambiguous.
  await mkdir(join(folder, 'a'), { recursive: true });
  await mkdir(join(folder, 'b'), { recursive: true });
  await writeFile(join(folder, 'a', 'shared.md'), '# Shared A\n\nText.\n', 'utf8');
  await writeFile(join(folder, 'b', 'shared.md'), '# Shared B\n\nText.\n', 'utf8');
  await writeFile(join(folder, 'ambiguous.md'), '# Ambiguous\n\nSee [[shared]].\n', 'utf8');

  const imported = async (path: string, title: string, body: string) =>
    (
      await knowledge.create(actor, {
        title,
        body,
        type: 'document',
        external: { source_system: 'markdown-folder', external_key: path },
      })
    ).item.id;
  escalationId = await imported('escalation.md', 'Escalation path', 'Support first. See [[rota]].');
  rotaId = await imported(
    'rota.md',
    'Rota',
    'Who is on call. See [[escalation]] and [[Nothing at all]].',
  );
  await imported('ambiguous.md', 'Ambiguous', 'See [[shared]].');
  selfishId = await imported('selfish.md', 'Selfish', 'See [[selfish]].');
  settledId = (
    await knowledge.create(actor, {
      title: 'Settled',
      body: 'See [[rota]].',
      type: 'document',
      external: { source_system: 'markdown-folder', external_key: 'settled.md' },
      relations: [{ type: 'relates_to', target: rotaId as never }],
    })
  ).item.id;
}, 240_000);

afterAll(async () => {
  await handle?.close().catch(() => undefined);
  await container?.stop();
  for (const dir of [dataDir, folder]) if (dir) await rm(dir, { recursive: true, force: true });
});

describe('knoverge link-from-folder', () => {
  it('proposes the relations the links describe, and says what went nowhere', async () => {
    const result = await linkFromFolder(services, {
      workspaceId,
      agentId,
      from: folder,
      sourceSystem: 'markdown-folder',
      requestId: 'req-link',
    });

    // Five notes are items and carry links; the rest carry none.
    expect(result.examined).toBe(5);
    // Two get a new relation. `selfish.md` links to itself and `settled.md`
    // already has the relation its link describes, so neither is a change and
    // neither becomes a proposal nobody asked for.
    expect(result.proposed).toBe(2);
    // An agent proposes by default (rule 14), so these wait for review.
    expect(result.written).toBe(0);

    const proposals = await services.repositories.proposals.list(workspaceId, { limit: 50 });
    const updates = proposals.filter((p) => p.proposalType === 'knowledge_update');
    const relations = updates.flatMap(
      (p) =>
        (p.proposedPayload as { relations?: { type: string; target: string }[] }).relations ?? [],
    );
    // Every link becomes `relates_to`: a wiki link says two notes are connected
    // and nothing more precise, and reading `supersedes` into one would be
    // inventing a claim the person never made.
    expect(relations.every((relation) => relation.type === 'relates_to')).toBe(true);
    expect(relations.map((relation) => relation.target).sort()).toEqual(
      [escalationId, rotaId].sort(),
    );
  });

  it('names a link that points at nothing, and one that points at two things', async () => {
    const result = await linkFromFolder(services, {
      workspaceId,
      agentId,
      from: folder,
      sourceSystem: 'markdown-folder',
      requestId: 'req-link-2',
    });
    const why = (target: string) => result.unresolved.find((link) => link.target === target)?.why;

    // A name nothing has, a name two notes have, and a note nobody accepted:
    // three different reasons, and a person fixing them needs to know which.
    expect(why('Nothing at all')).toBe('no note has that name');
    expect(why('shared')).toBe('several notes have that name');
    expect(result.unresolved.find((link) => link.from === 'orphan.md')?.why).toBe(
      'this note is not an item yet',
    );
  });

  it('leaves alone a note whose relation is already there, and one that links to itself', async () => {
    const result = await linkFromFolder(services, {
      workspaceId,
      agentId,
      from: folder,
      sourceSystem: 'markdown-folder',
      requestId: 'req-link-3',
    });

    const proposals = await services.repositories.proposals.list(workspaceId, { limit: 100 });
    const targets = proposals
      .filter((p) => p.proposalType === 'knowledge_update')
      .map((p) => p.targetItemId);
    // `settled.md` already has the relation its link describes, so proposing it
    // again would put the same change in the queue twice.
    expect(targets).not.toContain(settledId);
    // And a note that links to itself is not a relation, it is a note that
    // mentions its own name.
    expect(targets).not.toContain(selfishId);
    expect(result.unresolved.some((link) => link.from === 'selfish.md')).toBe(false);
  });
});
