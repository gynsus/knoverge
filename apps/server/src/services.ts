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

export interface ServicesConfig {
  databaseUrl: string;
  ledgerKey: LedgerKey;
  /** Peppers agent credential hashes so a leaked database cannot be brute-forced offline. */
  tokenPepper: string;
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
  });
  const workspaces = new WorkspaceService({
    uow,
    workspaces: repositories.workspaces,
    actors: repositories.actors,
    ledger,
  });
  const authorization = new AuthorizationService({
    uow,
    grants: repositories.grants,
    rules: repositories.policyRules,
    categories: repositories.categories,
    ledger,
  });
  const authorizationAdmin = new AuthorizationAdminService({
    uow,
    grants: repositories.grants,
    rules: repositories.policyRules,
    categories: repositories.categories,
    ledger,
  });
  const taxonomy = new TaxonomyService({
    uow,
    categories: repositories.categories,
    aliases: repositories.aliases,
    versions: repositories.taxonomyVersions,
    ledger,
  });
  const bootstrap = new BootstrapService({
    uow,
    users,
    workspaces,
    workspaceRepository: repositories.workspaces,
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
    taxonomy,
    users,
    sessions,
    workspaces,
    bootstrap,
    close: () => database.close(),
  };
}

export type Services = ReturnType<typeof createServices>;
