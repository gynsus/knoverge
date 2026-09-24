import type { WorkspaceId } from '@knoverge/contracts';
import { createHttpEmbeddingProvider, probeProvider } from '@knoverge/intelligence';

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
  AiSettingsService,
  EmbeddingService,
  EventLedger,
  SearchService,
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
  /**
   * Asks for a sync session's provisional candidates to be settled.
   *
   * Injected rather than reached for: the job runner needs these services to
   * do the settling and these services need it to ask, so a closure resolved
   * at call time is how the two are wired without a cycle. Absent on an
   * API-only process, where nothing here runs jobs.
   */
  enqueueRefine?: (workspaceId: string, sessionId: string) => Promise<void>;
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
  /**
   * The API key for an address, when the environment holds one.
   *
   * Keys stay in the environment. A key in the database needs encryption at
   * rest, a key to encrypt it with and a decision about what happens when that
   * is lost, and none of those is this change (ADR 0021) — so the interface
   * can configure a provider but never a secret, and a provider that needs one
   * is a provider whose address is named in the environment.
   */
  apiKeyFor?: (baseUrl: string) => string | undefined;
  /**
   * Told when the semantic half of a search failed.
   *
   * Logged rather than raised: the provider is somebody else's server, and a
   * search that failed because an optional feature was unavailable would make
   * the feature mandatory.
   */
  onSemanticFailure?: (workspaceId: WorkspaceId, error: unknown) => void;
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
    actors: repositories.actors,
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
    workspaces: repositories.workspaces,
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
    sync: repositories.sync,
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
  /**
   * What is configured, and how to talk to it.
   *
   * The provider is not decided here. An operator connects one, changes the
   * model and disconnects it while the product runs (ADR 0021), so everything
   * below asks `embeddingSource` rather than holding what was true at start-up
   * — and null, meaning nothing configured, stays the ordinary answer.
   */
  const ai = new AiSettingsService({
    repository: repositories.ai,
    embeddings: (spec) =>
      createHttpEmbeddingProvider({
        provider: spec.kind,
        baseUrl: spec.baseUrl,
        model: spec.model,
        apiKey: config.apiKeyFor?.(spec.baseUrl),
      }),
    probe: (spec) => probeProvider({ ...spec, apiKey: config.apiKeyFor?.(spec.baseUrl) }),
  });
  const embeddingSource = ai.embeddingSource;
  const embeddings = new EmbeddingService({
    uow,
    embeddings: repositories.embeddings,
    source: embeddingSource,
  });
  /**
   * Passages nearest in meaning to a text, for the duplicate check.
   *
   * Answers with nothing rather than throwing: this runs on the write path,
   * and a write refused because an optional feature was down would make the
   * feature mandatory (rule 9). The budget is short for the same reason —
   * somebody proposing knowledge is waiting for it.
   */
  const nearest = async (workspaceId: WorkspaceId, text: string, limit: number) => {
    try {
      const provider = await embeddingSource();
      if (!provider) return [];
      const profile = await embeddings.activeProfile(workspaceId);
      if (!profile) return [];
      const [vector] = await provider.embed([text]);
      if (!vector) return [];
      const candidates = await repositories.search.semantic(
        { workspaceId, text, statuses: ['active'] },
        vector,
        profile.id,
        limit,
      );
      return candidates.map((candidate) => ({
        itemId: candidate.itemId,
        title: candidate.title,
        markdownPath: candidate.markdownPath,
        similarity: candidate.components.semantic ?? 0,
      }));
    } catch {
      return [];
    }
  };

  const proposals = new ProposalService({
    uow,
    proposals: repositories.proposals,
    knowledge,
    knowledgeIndex: repositories.knowledge,
    categories: repositories.categories,
    authorization,
    duplicates: new DuplicateMatcher({
      items: repositories.knowledge,
      contentHash,
      // Always wired, because whether anything answers is now a question with
      // a current answer rather than a fact known at start-up. With nothing
      // configured it returns no candidates, which is what it did before.
      nearest,
    }),
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
  const search = new SearchService({
    search: repositories.search,
    embeddings,
    source: embeddingSource,
    ...(config.onSemanticFailure ? { onSemanticFailure: config.onSemanticFailure } : {}),
  });
  const sync = new SyncService({
    uow,
    sync: repositories.sync,
    items: repositories.knowledge,
    categories: repositories.categories,
    workspaces: repositories.workspaces,
    nearest: async (workspaceId: WorkspaceId, text: string, limit: number) =>
      (await nearest(workspaceId, text, limit)).map((match) => ({
        itemId: match.itemId,
        similarity: match.similarity,
      })),
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
    search,
    embeddings,
    ai,
    enqueueRefine: config.enqueueRefine ?? (async () => undefined),
    users,
    sessions,
    workspaces,
    bootstrap,
    close: () => database.close(),
  };
}

export type Services = ReturnType<typeof createServices>;
