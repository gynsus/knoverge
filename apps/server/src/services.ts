import type { WorkspaceId } from '@knoverge/contracts';
import {
  dummyPasswordHash,
  generateOpaqueToken,
  hashPassword,
  hashToken,
  verifyPassword,
} from '@knoverge/auth';
import {
  AgentService,
  AuthorizationAdminService,
  AuthorizationService,
  BootstrapService,
  EventLedger,
  CrossStoreWriter,
  DuplicateMatcher,
  IdempotencyService,
  MaintenanceService,
  RecoveryService,
  MemberService,
  KnowledgeRecovery,
  KnowledgeService,
  ProposalService,
  TaxonomyRecovery,
  TaxonomyService,
  SessionService,
  SyncService,
  UserService,
  WorkspaceService,
  type LedgerKey,
} from '@knoverge/core';
import {
  createDatabase,
  createRepositories,
  createUnitOfWork,
  type DatabaseHandle,
} from '@knoverge/db';
import {
  TAXONOMY_PATH,
  contentHash,
  createGitStore,
  frontmatterHash,
  parseItem,
  parseTaxonomy,
  renderItem,
  renderTaxonomy,
  slugifyTitle,
  uniqueSlug,
} from '@knoverge/git-store';

export interface ServicesConfig {
  databaseUrl: string;
  ledgerKey: LedgerKey;
  /** Peppers agent credential hashes so a leaked database cannot be brute-forced offline. */
  tokenPepper: string;
  /** Workspace repositories live under this directory. */
  dataDir: string;
  /** What the manifest reports as the running build. */
  version?: string;
  poolMax?: number;
  /** Told when a pooled connection dies while nobody is using it. */
  onPoolError?: (error: Error) => void;
}

/**
 * Composition root: database, repositories, ledger and domain services.
 */
export function createServices(config: ServicesConfig) {
  const database: DatabaseHandle = createDatabase({
    connectionString: config.databaseUrl,
    max: config.poolMax ?? 10,
    ...(config.onPoolError ? { onPoolError: config.onPoolError } : {}),
  });
  const uow = createUnitOfWork(database.db);
  const repositories = createRepositories(database.db);
  const ledger = new EventLedger({ key: config.ledgerKey, events: repositories.events });
  const users = new UserService({
    sessions: repositories.sessions,
    uow,
    users: repositories.users,
    passwords: { hash: hashPassword, verify: verifyPassword, dummyHash: dummyPasswordHash },
  });
  const sessions = new SessionService({
    uow,
    sessions: repositories.sessions,
    tokens: { generate: generateOpaqueToken, hash: hashToken },
  });
  const authorization = new AuthorizationService({
    uow,
    grants: repositories.grants,
    rules: repositories.policyRules,
    categories: repositories.categories,
    ledger,
  });
  const agentService = new AgentService({
    uow,
    agents: repositories.agents,
    credentials: repositories.credentials,
    actors: repositories.actors,
    ledger,
    tokens: {
      generate: generateOpaqueToken,
      hash: (token) => hashToken(token, config.tokenPepper),
    },
    authorization,
  });
  const workspaces = new WorkspaceService({
    uow,
    workspaces: repositories.workspaces,
    actors: repositories.actors,
    ledger,
  });
  const authorizationAdmin = new AuthorizationAdminService({
    uow,
    grants: repositories.grants,
    rules: repositories.policyRules,
    categories: repositories.categories,
    actors: repositories.actors,
    memberships: repositories.memberships,
    authorization,
    ledger,
  });
  const idempotency = new IdempotencyService({ uow, records: repositories.idempotency });
  const maintenance = new MaintenanceService({
    uow,
    sessions: repositories.sessions,
    operations: repositories.operations,
    proposals: repositories.proposals,
    idempotency,
  });
  const git = createGitStore({ dataDir: config.dataDir });
  const crossStore = new CrossStoreWriter({
    uow,
    operations: repositories.operations,
    commitExists: (workspaceId, operationId) => git.hasCommitForOperation(workspaceId, operationId),
  });
  // What finishes a knowledge write that reached Git and no further. Without
  // it such an operation stays unresolved and its workspace refuses writes.
  const knowledgeRecovery = new KnowledgeRecovery({
    uow,
    items: repositories.knowledge,
    revisions: repositories.revisions,
    categories: repositories.categories,
    relations: repositories.relations,
    search: repositories.search,
    ledger,
    git,
    parseItem,
    contentHash,
    frontmatterHash,
  });
  const taxonomyRecovery = new TaxonomyRecovery({
    uow,
    categories: repositories.categories,
    aliases: repositories.aliases,
    versions: repositories.taxonomyVersions,
    ledger,
    git,
    taxonomyPath: TAXONOMY_PATH,
    items: repositories.knowledge,
    uniqueSlug,
    parseTaxonomy,
  });
  const recovery = new RecoveryService({
    uow,
    operations: repositories.operations,
    commitExists: (workspaceId, operationId) => git.hasCommitForOperation(workspaceId, operationId),
    // Each knows the operations it can finish, so the order only decides who
    // is asked first, not who answers.
    completeFromCommit: async (operation) =>
      (await knowledgeRecovery.complete(operation)) || (await taxonomyRecovery.complete(operation)),
  });
  const workspaceLookup = {
    findById: async (workspaceId: WorkspaceId) => {
      const workspace = await repositories.workspaces.findById(workspaceId);
      return workspace
        ? {
            id: workspace.id,
            name: workspace.name,
            defaultLanguage: workspace.defaultLanguage,
          }
        : null;
    },
  };
  const knowledge = new KnowledgeService({
    uow,
    items: repositories.knowledge,
    revisions: repositories.revisions,
    sources: repositories.sources,
    relations: repositories.relations,
    search: repositories.search,
    categories: repositories.categories,
    versions: repositories.taxonomyVersions,
    actors: repositories.actors,
    workspaces: workspaceLookup,
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
  const proposals = new ProposalService({
    uow,
    proposals: repositories.proposals,
    knowledge,
    categories: repositories.categories,
    authorization,
    duplicates: new DuplicateMatcher({ items: repositories.knowledge, contentHash }),
    actors: repositories.actors,
    ledger,
  });
  const taxonomy = new TaxonomyService({
    uow,
    categories: repositories.categories,
    aliases: repositories.aliases,
    versions: repositories.taxonomyVersions,
    ledger,
    crossStore,
    git,
    renderTaxonomy,
    taxonomyPath: TAXONOMY_PATH,
    items: repositories.knowledge,
    parseItem,
    renderItem,
    uniqueSlug,
    workspaces: {
      findById: async (workspaceId) => {
        const workspace = await repositories.workspaces.findById(workspaceId);
        return workspace ? { id: workspace.id, name: workspace.name } : null;
      },
    },
    actors: repositories.actors,
  });
  const members = new MemberService({
    sessions: repositories.sessions,
    uow,
    memberships: repositories.memberships,
    actors: repositories.actors,
    workspaces: repositories.workspaces,
    users,
    authorization,
    workspaceService: workspaces,
    ledger,
  });
  const sync = new SyncService({
    uow,
    sync: repositories.sync,
    items: repositories.knowledge,
    categories: repositories.categories,
  });
  const bootstrap = new BootstrapService({
    uow,
    users,
    workspaces,
    memberships: repositories.memberships,
    actors: repositories.actors,
    ledger,
  });
  return {
    serverVersion: config.version ?? '0.0.0',
    database,
    uow,
    repositories,
    ledger,
    agents: agentService,
    authorization,
    authorizationAdmin,
    idempotency,
    maintenance,
    recovery,
    members,
    knowledge,
    proposals,
    taxonomy,
    sync,
    users,
    sessions,
    workspaces,
    bootstrap,
    close: () => database.close(),
  };
}

export type Services = ReturnType<typeof createServices>;
