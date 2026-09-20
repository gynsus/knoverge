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
  IdempotencyService,
  MaintenanceService,
  RecoveryService,
  MemberService,
  TaxonomyService,
  SessionService,
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
import { TAXONOMY_PATH, createGitStore, renderTaxonomy } from '@knoverge/git-store';

export interface ServicesConfig {
  databaseUrl: string;
  ledgerKey: LedgerKey;
  /** Peppers agent credential hashes so a leaked database cannot be brute-forced offline. */
  tokenPepper: string;
  /** Workspace repositories live under this directory. */
  dataDir: string;
  poolMax?: number;
}

/**
 * Composition root: database, repositories, ledger and domain services.
 */
export function createServices(config: ServicesConfig) {
  const database: DatabaseHandle = createDatabase({
    connectionString: config.databaseUrl,
    max: config.poolMax ?? 10,
  });
  const uow = createUnitOfWork(database.db);
  const repositories = createRepositories(database.db);
  const ledger = new EventLedger({ key: config.ledgerKey, events: repositories.events });
  const users = new UserService({
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
    idempotency,
  });
  const git = createGitStore({ dataDir: config.dataDir });
  const crossStore = new CrossStoreWriter({
    uow,
    operations: repositories.operations,
    commitExists: (workspaceId, operationId) => git.hasCommitForOperation(workspaceId, operationId),
  });
  const recovery = new RecoveryService({
    uow,
    operations: repositories.operations,
    commitExists: (workspaceId, operationId) => git.hasCommitForOperation(workspaceId, operationId),
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
    workspaces: {
      findById: async (workspaceId) => {
        const workspace = await repositories.workspaces.findById(workspaceId);
        return workspace ? { id: workspace.id, name: workspace.name } : null;
      },
    },
    actors: repositories.actors,
  });
  const members = new MemberService({
    uow,
    memberships: repositories.memberships,
    actors: repositories.actors,
    workspaces: repositories.workspaces,
    users,
    authorization,
    ledger,
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
    taxonomy,
    users,
    sessions,
    workspaces,
    bootstrap,
    close: () => database.close(),
  };
}

export type Services = ReturnType<typeof createServices>;
