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
  MemberService,
  CrossStoreWriter,
  EventLedger,
  IdempotencyService,
  KnowledgeRecovery,
  KnowledgeService,
  MaintenanceService,
  RecoveryService,
  TaxonomyRecovery,
  TaxonomyService,
  SessionService,
  UserService,
  WorkspaceService,
  parseLedgerKey,
} from '@knoverge/core';
import { createDatabase, createRepositories, createUnitOfWork } from '@knoverge/db';
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
        sessions: repositories.sessions,
        uow,
        users: repositories.users,
        actors: repositories.actors,
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
        workspaces: repositories.workspaces,
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
        operations: repositories.operations,
        proposals: repositories.proposals,
        sync: repositories.sync,
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
  const crossStore = lazy(
    () =>
      new CrossStoreWriter({
        uow,
        operations: repositories.operations,
        commitExists: (workspaceId, operationId) =>
          git().hasCommitForOperation(workspaceId, operationId),
      }),
  );
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
      }),
  );
  // What finishes a write that reached Git and no further. The server builds
  // the same three at startup; the command line has them so an operator can
  // resolve a blocked workspace without restarting the process. The workspace
  // lock is a PostgreSQL advisory lock, so this is safe to run against a
  // installation that is up: it waits for whatever is writing.
  const recovery = lazy(
    () =>
      new RecoveryService({
        uow,
        operations: repositories.operations,
        commitExists: (workspaceId, operationId) =>
          git().hasCommitForOperation(workspaceId, operationId),
        // Each knows the operations it can finish, so the order only decides
        // who is asked first, not who answers.
        completeFromCommit: async (operation) =>
          (await new KnowledgeRecovery({
            uow,
            items: repositories.knowledge,
            revisions: repositories.revisions,
            categories: repositories.categories,
            relations: repositories.relations,
            summaries: repositories.summaries,
            search: repositories.search,
            ledger: ledger(),
            git: git(),
            parseItem,
            contentHash,
            frontmatterHash,
          }).complete(operation)) ||
          (await new TaxonomyRecovery({
            uow,
            categories: repositories.categories,
            aliases: repositories.aliases,
            versions: repositories.taxonomyVersions,
            ledger: ledger(),
            git: git(),
            taxonomyPath: TAXONOMY_PATH,
            items: repositories.knowledge,
            uniqueSlug,
            parseTaxonomy,
          }).complete(operation)),
      }),
  );
  // Only the reindex command builds this, and it reads the repository rather
  // than writing to it: the cross-store writer it would need for a write is
  // the server's, and a command-line rebuild takes no lock on knowledge.
  const knowledge = lazy(
    () =>
      new KnowledgeService({
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
        workspaces: repositories.workspaces,
        ledger: ledger(),
        crossStore: crossStore(),
        git: git(),
        slugifyTitle,
        uniqueSlug,
        renderItem,
        parseItem,
        contentHash,
        frontmatterHash,
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
  // Only what creating a workspace with an owner needs. The command line has
  // no request and no actor, so nothing here is asked to authorise anything.
  const members = lazy(
    () =>
      new MemberService({
        uow,
        memberships: repositories.memberships,
        actors: repositories.actors,
        workspaces: repositories.workspaces,
        users: users(),
        sessions: repositories.sessions,
        authorization: authorization(),
        workspaceService: workspaces(),
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
    get recovery() {
      return recovery();
    },
    get taxonomy() {
      return taxonomy();
    },
    get knowledge() {
      return knowledge();
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
    get members() {
      return members();
    },
    get bootstrap() {
      return bootstrap();
    },
    close: () => database.close(),
  };
}
