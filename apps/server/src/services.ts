import { resolve } from 'node:path';

import {
  listBackups,
  systemTools,
  takeBackup,
  uploadBackup,
  type BackupTools,
} from '@knoverge/backups';
import type { WorkspaceId } from '@knoverge/contracts';
import {
  createHttpEmbeddingProvider,
  createHttpGenerationProvider,
  createHttpTranscriptionProvider,
  probeProvider,
} from '@knoverge/intelligence';

import {
  dummyPasswordHash,
  generateOpaqueToken,
  hashPassword,
  hashToken,
  open as openSealed,
  seal,
  verifyPassword,
  type EncryptionKey,
} from '@knoverge/auth';
import {
  AgentService,
  BackupService,
  OauthService,
  AttachmentExtractor,
  AttachmentService,
  MediaDescriber,
  MediaTranscriber,
  MAX_BODY_BYTES,
  AuthorizationAdminService,
  DomainError,
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
  DigestNarrator,
  KnowledgeService,
  SummaryDrafter,
  ProposalService,
  TaxonomyRecovery,
  TaxonomyService,
  SessionService,
  WebhookService,
  SyncService,
  UserService,
  WorkspaceService,
  type BackupUploader,
  type LedgerKey,
  type LedgerKeyring,
} from '@knoverge/core';
import { FileAttachmentStore, extractText } from '@knoverge/attachments';
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
   * Where this installation answers, which is what the authorization server
   * calls itself and what a token is good for (ADR 0038). A test that says
   * nothing gets the same default the environment schema gives.
   */
  baseUrl?: URL;
  /**
   * Asks for a sync session's provisional candidates to be settled.
   *
   * Injected rather than reached for: the job runner needs these services to
   * do the settling and these services need it to ask, so a closure resolved
   * at call time is how the two are wired without a cycle. Absent on an
   * API-only process, where nothing here runs jobs.
   */
  enqueueRefine?: (workspaceId: string, sessionId: string) => Promise<void>;
  /**
   * One key, or the keyring a rotated installation runs with (ADR 0030).
   *
   * A test that has never rotated passes one key and means the same thing.
   */
  ledgerKey: LedgerKey | LedgerKeyring;
  /** Peppers agent credential hashes so a leaked database cannot be brute-forced offline. */
  tokenPepper: string;
  /**
   * Opens and seals the secrets the server has to reuse in clear.
   *
   * Only webhook signing secrets today. Absent on an installation that has not
   * configured one, and a webhook cannot then be created: refusing is better than
   * storing a signing secret the operator believes is encrypted.
   */
  encryptionKey?: EncryptionKey;
  /** Workspace repositories and attachments live under this directory. */
  dataDir: string;
  /**
   * Where the copies this installation takes of itself go.
   *
   * Defaulted rather than required, for the reason the attachment size is:
   * every test that builds services would otherwise carry a directory it does
   * not use. Never inside `dataDir`, which is what the archive is made of.
   */
  backupDir?: string;
  /**
   * The two programs a backup shells out to.
   *
   * A seam, and the same one the package documents: `pg_dump` has to match the
   * server's major version, so a test that used the host's copy would pass or
   * fail on the host. The default is the real pair.
   */
  backupTools?: BackupTools;
  /**
   * Where a finished copy is sent, for the same reason the tools are a seam: a
   * test that reached a real machine over SSH would be testing somebody's
   * network. The default is the real one (ADR 0041).
   */
  backupUploader?: BackupUploader;
  /**
   * The largest file an upload may carry, in bytes.
   *
   * Defaulted here rather than required, because every test that builds services
   * would otherwise carry a number it does not care about.
   */
  attachmentMaxBytes?: number;
  /**
   * How many proposals one actor may have waiting for review.
   *
   * A domain rule rather than a transport one — it protects the review queue, not
   * the server — so the service holds it and the environment sets it. The default
   * lives in the domain.
   */
  pendingPerActor?: number;
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
/** The key, or the reason there is nothing to do without it. */
function requireEncryptionKey(key: EncryptionKey | undefined): EncryptionKey {
  if (!key) {
    throw new DomainError(
      'VALIDATION_ERROR',
      'this installation has no KNOVERGE_ENCRYPTION_KEY, so it cannot keep a webhook signing secret',
    );
  }
  return key;
}

/** What an installation accepts when nothing said otherwise: the config's own default. */
const DEFAULT_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

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
    oauthGrants: repositories.oauthGrants,
    oauthRefreshTokens: repositories.oauthRefreshTokens,
  });
  const issuer = (config.baseUrl ?? new URL('http://localhost:3000')).href.replace(/\/$/u, '');
  const oauth = new OauthService({
    uow,
    clients: repositories.oauthClients,
    grants: repositories.oauthGrants,
    codes: repositories.oauthCodes,
    refreshTokens: repositories.oauthRefreshTokens,
    credentials: repositories.credentials,
    agents: repositories.agents,
    actors: repositories.actors,
    ledger,
    tokens: {
      generate: generateOpaqueToken,
      hash: (token) => hashToken(token, config.tokenPepper),
    },
    resource: `${issuer}/mcp`,
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
    oauthClients: repositories.oauthClients,
    oauthCodes: repositories.oauthCodes,
    oauthRefreshTokens: repositories.oauthRefreshTokens,
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
    sources: repositories.sources,
    summaries: repositories.summaries,
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
    summaries: repositories.summaries,
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
  /**
   * The key to use for an address.
   *
   * What the provider itself holds comes first: it was configured here, for this
   * address, by somebody who meant it. The environment is the fallback, so an
   * installation that has been sending `KNOVERGE_EMBEDDING_API_KEY` since before
   * the field existed keeps working without anybody re-entering anything (ADR
   * 0033).
   */
  const keyFor = (spec: { baseUrl: string; apiKey?: string | undefined }) =>
    spec.apiKey ?? config.apiKeyFor?.(spec.baseUrl);

  const ai = new AiSettingsService({
    repository: repositories.ai,
    embeddings: (spec) =>
      createHttpEmbeddingProvider({
        provider: spec.kind,
        baseUrl: spec.baseUrl,
        model: spec.model,
        apiKey: keyFor(spec),
      }),
    generation: (spec) =>
      createHttpGenerationProvider({
        provider: spec.kind,
        baseUrl: spec.baseUrl,
        model: spec.model,
        apiKey: keyFor(spec),
      }),
    transcription: (spec) =>
      createHttpTranscriptionProvider({
        provider: 'openai_compatible',
        baseUrl: spec.baseUrl,
        model: spec.model,
        apiKey: keyFor(spec),
      }),
    probe: (spec) => probeProvider({ ...spec, apiKey: keyFor(spec) }),
    // Absent without a key, and then a provider key cannot be given at all —
    // the same answer webhooks give about their signing secrets.
    ...(config.encryptionKey
      ? {
          secrets: {
            seal: (plaintext: string) => seal(config.encryptionKey as EncryptionKey, plaintext),
            open: (sealed: string) => openSealed(config.encryptionKey as EncryptionKey, sealed),
          },
        }
      : {}),
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

  // Files live beside the repositories under the data directory, never in Git
  // (ADR 0008). One store for the process, because a store is a path and a path
  // is not state.
  const attachmentStore = new FileAttachmentStore(config.dataDir);
  const attachmentMaxBytes = config.attachmentMaxBytes ?? DEFAULT_ATTACHMENT_MAX_BYTES;
  const backupDir = config.backupDir ?? resolve(config.dataDir, '..', 'backups');
  const attachments = new AttachmentService({
    uow,
    attachments: repositories.attachments,
    store: attachmentStore,
    ledger,
    maxBytes: attachmentMaxBytes,
  });

  // Whether to take a copy is the domain's; taking one is the backup package's.
  // The source is the three things it asks about the installation: the
  // workspaces, where each ledger stands, and the write lock.
  const backups = new BackupService({
    uow,
    settings: repositories.backupSettings,
    store: {
      take: ({ retentionDays, now }) =>
        takeBackup(
          {
            workspaces: () => repositories.workspaces.list(),
            latestSequence: (workspaceId) =>
              repositories.events.latestSequence(workspaceId as WorkspaceId),
            withWorkspaceLock: (workspaceId, fn) => uow.withWorkspaceLock(workspaceId, fn),
          },
          {
            into: backupDir,
            dataDir: config.dataDir,
            retentionDays,
            now,
          },
          config.backupTools ?? systemTools(config.databaseUrl),
        ),
      list: () => listBackups(backupDir),
    },
    // SSH from this process rather than a binary in the image: the key is
    // sealed in the database and never reaches a filesystem (ADR 0041).
    uploader: config.backupUploader ?? { upload: (options) => uploadBackup(options) },
    // Absent without a key, and then a target cannot be configured at all —
    // the same answer webhooks and providers give (ADR 0033).
    ...(config.encryptionKey
      ? {
          secrets: {
            seal: (plaintext: string) => seal(config.encryptionKey as EncryptionKey, plaintext),
            open: (sealed: string) => openSealed(config.encryptionKey as EncryptionKey, sealed),
          },
        }
      : {}),
  });

  const webhooks = new WebhookService({
    uow,
    webhooks: repositories.webhooks,
    events: repositories.events,
    categories: repositories.categories,
    // Refusing beats pretending: without a key there is nowhere safe to put a
    // signing secret, and a webhook whose secret is stored in clear is worse
    // than one that was never created.
    seal: (plaintext) => seal(requireEncryptionKey(config.encryptionKey), plaintext),
    open: (sealed) => openSealed(requireEncryptionKey(config.encryptionKey), sealed),
    newSecret: () => `whsec_${generateOpaqueToken()}`,
  });
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
    ...(config.pendingPerActor === undefined ? {} : { pendingPerActor: config.pendingPerActor }),
  });

  /**
   * Reading the text out of files, as the person or agent who uploaded them.
   *
   * After the knowledge and proposal services because it writes through both: a
   * person's file becomes a document, an agent's becomes a proposal, and which of
   * the two is not this job's decision (rule 5).
   */
  const attachmentExtractor = new AttachmentExtractor({
    attachments: repositories.attachments,
    actors: repositories.actors,
    standingOf: async (actor) => {
      if (actor.actorType === 'agent' && actor.agentId) {
        const agent = await repositories.agents.findById(actor.workspaceId, actor.agentId);
        return agent ? { trustTier: agent.trustTier } : {};
      }
      const members = await repositories.memberships.listForWorkspace(actor.workspaceId);
      const member = members.find((m) => m.actorId === actor.actorId);
      return member ? { role: member.role } : {};
    },
    store: attachmentStore,
    knowledge,
    proposals,
    extract: extractText,
    // Asked only about what nothing here could read, and only if an operator has
    // assigned a model that can look at a picture (rule 9).
    describe: (mediaType, bytes) =>
      new MediaDescriber({ vision: ai.visionSource }).describe(mediaType, bytes),
    transcribe: (mediaType, bytes, filename) =>
      new MediaTranscriber({ transcription: ai.transcriptionSource }).transcribe(
        mediaType,
        bytes,
        filename,
      ),
    maxCharacters: MAX_BODY_BYTES,
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
    /**
     * What outside the taxonomy still refers to a category (ADR 0025).
     *
     * Grants and policy rules keep their scope as JSON with no foreign key, so
     * nothing in the database would object to deleting a category out from
     * under one. They are few per workspace, so listing them is cheaper than
     * an index nothing else would use.
     */
    references: async (workspaceId, categoryId) => {
      const names = (scope: { categories: readonly { category_id: string }[] }) =>
        scope.categories.some((c) => c.category_id === categoryId);
      const [proposalCount, grants, rules] = await Promise.all([
        repositories.proposals.countForCategory(workspaceId, categoryId),
        repositories.grants.list(workspaceId),
        repositories.policyRules.list(workspaceId),
      ]);
      return {
        proposals: proposalCount,
        grants: grants.filter((grant) => names(grant.scope)).length,
        policyRules: rules.filter((rule) => names(rule.scope)).length,
      };
    },
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
  /**
   * Drafting the text of a summary with a model.
   *
   * Reads bodies out of Git, because that is where knowledge is. It drafts and
   * never writes: what comes back goes through the ordinary write, which is
   * where provenance, review and Git already live.
   */
  const summaryDrafter = new SummaryDrafter({
    items: repositories.knowledge,
    revisions: repositories.revisions,
    read: async (workspaceId, itemId) => {
      const item = await repositories.knowledge.findById(workspaceId, itemId);
      if (!item?.currentRevisionId) return null;
      const revision = await repositories.revisions.findById(workspaceId, item.currentRevisionId);
      const file = await git.read(workspaceId, item.markdownPath);
      if (!revision || file === null) return null;
      return { itemId, title: revision.title, body: parseItem(file).body };
    },
    generation: ai.generationSource,
  });
  /**
   * The optional prose on top of a digest.
   *
   * Written from the digest's own numbers and titles, never from knowledge text:
   * a digest says what happened in a workspace, not what the workspace knows.
   */
  const digestNarrator = new DigestNarrator(ai.generationSource);
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
    oauth,
    /** The issuer, with no trailing slash: every OAuth document is built from it. */
    issuer,
    summaryDrafter,
    digestNarrator,
    authorization,
    authorizationAdmin,
    idempotency,
    maintenance,
    recovery,
    members,
    knowledge,
    proposals,
    attachments,
    attachmentExtractor,
    /** The largest file an upload may carry; the multipart parser needs it too. */
    attachmentMaxBytes,
    backups,
    webhooks,
    /**
     * Whether a webhook signing secret has somewhere to live.
     *
     * A fact about how this process was started rather than a domain rule, which
     * is why it is decided here: the sealing functions above throw when asked to
     * work without a key, and this is the same answer given before being asked.
     */
    secretStorage: config.encryptionKey !== undefined,
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
