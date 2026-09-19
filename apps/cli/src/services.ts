import {
  dummyPasswordHash,
  generateOpaqueToken,
  hashPassword,
  hashToken,
  verifyPassword,
} from '@knoverge/auth';
import {
  AgentService,
  AuthorizationService,
  BootstrapService,
  EventLedger,
  TaxonomyService,
  SessionService,
  UserService,
  WorkspaceService,
  parseLedgerKey,
} from '@knoverge/core';
import { createDatabase, createRepositories, createUnitOfWork } from '@knoverge/db';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/**
 * Composition root for CLI commands: database, repositories, ledger, services.
 */
export function createServices() {
  const database = createDatabase({ connectionString: required('KNOVERGE_DATABASE_URL'), max: 2 });
  const uow = createUnitOfWork(database.db);
  const repositories = createRepositories(database.db);
  const tokenPepper = required('KNOVERGE_TOKEN_PEPPER');
  const ledger = new EventLedger({
    key: parseLedgerKey(required('KNOVERGE_LEDGER_KEY')),
    events: repositories.events,
  });
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
  const agents = new AgentService({
    uow,
    agents: repositories.agents,
    credentials: repositories.credentials,
    actors: repositories.actors,
    ledger,
    tokens: { generate: generateOpaqueToken, hash: (token) => hashToken(token, tokenPepper) },
    authorization,
  });
  const taxonomy = new TaxonomyService({
    uow,
    categories: repositories.categories,
    aliases: repositories.aliases,
    versions: repositories.taxonomyVersions,
    ledger,
  });
  const workspaces = new WorkspaceService({
    uow,
    workspaces: repositories.workspaces,
    actors: repositories.actors,
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
    repositories,
    ledger,
    agents,
    taxonomy,
    uow,
    users,
    sessions,
    workspaces,
    bootstrap,
    close: () => database.close(),
  };
}
