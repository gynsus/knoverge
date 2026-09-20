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
  CrossStoreWriter,
  EventLedger,
  IdempotencyService,
  MaintenanceService,
  TaxonomyService,
  SessionService,
  UserService,
  WorkspaceService,
  parseLedgerKey,
} from '@knoverge/core';
import { createDatabase, createRepositories, createUnitOfWork } from '@knoverge/db';
import { TAXONOMY_PATH, createGitStore, renderTaxonomy } from '@knoverge/git-store';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/** Builds a value the first time it is asked for, and keeps it. */
function lazy<T>(build: () => T): () => T {
  let value: T | undefined;
  let built = false;
  return () => {
    if (!built) {
      value = build();
      built = true;
    }
    return value as T;
  };
}

/**
 * Composition root for command line commands.
 *
 * Secrets are resolved when something needs them, not when the process starts.
 * `knoverge workspace list` is one SELECT and needs neither the ledger key nor
 * the token pepper; demanding them anyway turned an ordinary listing into a
 * configuration error.
 */
export function createServices() {
  const database = createDatabase({
    connectionString: required('KNOVERGE_DATABASE_URL'),
    // A canonical write holds one connection for the workspace lock and opens
    // transactions on others, so two leaves nothing spare and any read during
    // a write would wait for a connection that the write itself is holding.
    max: 5,
  });
  const uow = createUnitOfWork(database.db);
  const repositories = createRepositories(database.db);

  const ledger = lazy(
    () =>
      new EventLedger({
        key: parseLedgerKey(required('KNOVERGE_LEDGER_KEY')),
        events: repositories.events,
      }),
  );
  const users = lazy(
    () =>
      new UserService({
        uow,
        users: repositories.users,
        passwords: { hash: hashPassword, verify: verifyPassword, dummyHash: dummyPasswordHash },
      }),
  );
  const sessions = lazy(
    () =>
      new SessionService({
        uow,
        sessions: repositories.sessions,
        tokens: { generate: generateOpaqueToken, hash: hashToken },
      }),
  );
  const authorization = lazy(
    () =>
      new AuthorizationService({
        uow,
        grants: repositories.grants,
        rules: repositories.policyRules,
        categories: repositories.categories,
        ledger: ledger(),
      }),
  );
  const idempotency = lazy(
    () => new IdempotencyService({ uow, records: repositories.idempotency }),
  );
  const maintenance = lazy(
    () =>
      new MaintenanceService({
        uow,
        sessions: repositories.sessions,
        idempotency: idempotency(),
      }),
  );
  const authorizationAdmin = lazy(
    () =>
      new AuthorizationAdminService({
        uow,
        grants: repositories.grants,
        rules: repositories.policyRules,
        categories: repositories.categories,
        actors: repositories.actors,
        memberships: repositories.memberships,
        authorization: authorization(),
        ledger: ledger(),
      }),
  );
  const agents = lazy(() => {
    const tokenPepper = required('KNOVERGE_TOKEN_PEPPER');
    return new AgentService({
      uow,
      agents: repositories.agents,
      credentials: repositories.credentials,
      actors: repositories.actors,
      ledger: ledger(),
      tokens: { generate: generateOpaqueToken, hash: (token) => hashToken(token, tokenPepper) },
      authorization: authorization(),
    });
  });
  const git = lazy(() => createGitStore({ dataDir: required('KNOVERGE_DATA_DIR') }));
  const crossStore = lazy(() => new CrossStoreWriter({ uow, operations: repositories.operations }));
  const taxonomy = lazy(
    () =>
      new TaxonomyService({
        uow,
        categories: repositories.categories,
        aliases: repositories.aliases,
        versions: repositories.taxonomyVersions,
        ledger: ledger(),
        crossStore: crossStore(),
        git: git(),
        renderTaxonomy,
        taxonomyPath: TAXONOMY_PATH,
        workspaces: {
          findById: async (workspaceId) => {
            const workspace = await repositories.workspaces.findById(workspaceId);
            return workspace ? { id: workspace.id, name: workspace.name } : null;
          },
        },
        actors: repositories.actors,
      }),
  );
  const workspaces = lazy(
    () =>
      new WorkspaceService({
        uow,
        workspaces: repositories.workspaces,
        actors: repositories.actors,
        ledger: ledger(),
      }),
  );
  const bootstrap = lazy(
    () =>
      new BootstrapService({
        uow,
        users: users(),
        workspaces: workspaces(),
        memberships: repositories.memberships,
        actors: repositories.actors,
        ledger: ledger(),
      }),
  );

  return {
    repositories,
    uow,
    get ledger() {
      return ledger();
    },
    get agents() {
      return agents();
    },
    get authorizationAdmin() {
      return authorizationAdmin();
    },
    get maintenance() {
      return maintenance();
    },
    get taxonomy() {
      return taxonomy();
    },
    get users() {
      return users();
    },
    get sessions() {
      return sessions();
    },
    get workspaces() {
      return workspaces();
    },
    get bootstrap() {
      return bootstrap();
    },
    close: () => database.close(),
  };
}
