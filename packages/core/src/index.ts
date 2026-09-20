export type { ActorContext } from './actor-context.ts';
export { KnowledgeRecovery, type KnowledgeRecoveryOptions } from './knowledge/recovery.ts';
export {
  KnowledgeService,
  MAX_BODY_BYTES,
  UNCATEGORISED_DIRECTORY,
  type CreateItemInput,
  type ItemResult,
  type ItemSummary,
  type KnowledgeServiceOptions,
} from './knowledge/service.ts';
export type {
  ItemCategoryRecord,
  KnowledgeItemRecord,
  KnowledgeRepository,
  ListItemsOptions,
  RelationRecord,
  RelationRepository,
  RevisionRecord,
  RevisionRepository,
  RevisionSourceRecord,
  SourceRecord,
  SourceRepository,
} from './knowledge/repository.ts';
export {
  AuthorizationAdminService,
  type AuthorizationAdminOptions,
  type GrantInput,
  type RuleInput,
} from './authorization/management.ts';
export type {
  PermissionGrantRecord,
  PermissionGrantRepository,
  PolicyRuleRecord,
  PolicyRuleRepository,
} from './authorization/repository.ts';
export {
  AuthorizationService,
  type ActorStanding,
  type AuthorizationDecision,
  type AuthorizationServiceOptions,
} from './authorization/service.ts';
export type {
  AgentPatch,
  AgentRecord,
  AgentRepository,
  CredentialRecord,
  CredentialRepository,
  ResolvedCredential,
} from './agents/repository.ts';
export {
  AgentService,
  TOKEN_PREFIX,
  TOUCH_INTERVAL_MS,
  type AgentServiceOptions,
  type CreateAgentInput,
  type IssueCredentialInput,
  type IssuedCredential,
  type UpdateAgentInput,
} from './agents/service.ts';
export { DomainError, type DomainErrorOptions } from './errors.ts';
export {
  BootstrapService,
  addMember,
  type BootstrapInput,
  type BootstrapResult,
  type BootstrapServiceOptions,
} from './identity/bootstrap-service.ts';
export type { PasswordHasher, TokenService } from './identity/ports.ts';
export type {
  MemberWithUser,
  MembershipRecord,
  MembershipRepository,
  MembershipWithWorkspace,
  SessionRecord,
  SessionRepository,
  UserRecord,
  UserRepository,
} from './identity/repository.ts';
export {
  SESSION_TTL_MS,
  SessionService,
  type IssuedSession,
  type SessionServiceOptions,
} from './identity/session-service.ts';
export {
  LOCKOUT_MS,
  MAX_FAILED_LOGINS,
  UserService,
  type CreateUserInput,
  type UserServiceOptions,
} from './identity/user-service.ts';
export { ID_PREFIXES, newId, type IdPrefix } from './ids.ts';
export type { IdempotencyRecord, IdempotencyRepository } from './idempotency/repository.ts';
export {
  IDEMPOTENCY_TTL_MS,
  IdempotencyKeyPattern,
  IdempotencyService,
  type IdempotencyServiceOptions,
  type IdempotentResult,
} from './idempotency/service.ts';
export { canonicalJson } from './ledger/canonical-json.ts';
export {
  HASH_PREFIX,
  MIN_LEDGER_KEY_BYTES,
  computeEventHash,
  genesisHash,
  parseLedgerKey,
  type LedgerKey,
} from './ledger/hash.ts';
export { EventLedger, type LedgerOptions, type VerifyResult } from './ledger/ledger.ts';
export type { EventRepository, LedgerHead } from './ledger/repository.ts';
export type { EventActor, EventInput, EventRecord } from './ledger/types.ts';
export { systemClock, type Clock } from './ports/clock.ts';
export type {
  AliasRecord,
  AliasRepository,
  CategoryPatch,
  CategoryRecord,
  CategoryRepository,
  TaxonomyVersionRepository,
} from './taxonomy/repository.ts';
export {
  MAX_CATEGORIES_PER_WORKSPACE,
  MAX_CATEGORY_DEPTH,
  MAX_TAXONOMY_BYTES,
  TaxonomyService,
  normaliseAlias,
  slugify,
  type CategoryWithAliases,
  type CreateCategoryInput,
  type TaxonomyResult,
  type TaxonomyServiceOptions,
  type UpdateCategoryInput,
} from './taxonomy/service.ts';
export type { Tx, UnitOfWork } from './ports/unit-of-work.ts';
export type {
  ActorRecord,
  ActorRepository,
  WorkspacePatch,
  WorkspaceRecord,
  WorkspaceRepository,
} from './workspace/repository.ts';
export {
  MemberService,
  type AddMemberInput,
  type MemberServiceOptions,
  type UpdateWorkspaceInput,
} from './workspace/members.ts';
export {
  SYSTEM_ACTOR_NAME,
  WorkspaceService,
  type CreateWorkspaceInput,
  type WorkspaceServiceOptions,
} from './workspace/service.ts';
export {
  MaintenanceService,
  OPERATION_RETENTION_MS,
  SESSION_RETENTION_MS,
  type MaintenanceOptions,
  type MaintenanceResult,
} from './maintenance/service.ts';
export type {
  OperationPatch,
  OperationRecord,
  OperationRepository,
  OperationState,
  OperationType,
} from './operations/repository.ts';
export {
  CrossStoreWriter,
  type CrossStoreOptions,
  type CrossStoreWrite,
} from './operations/service.ts';
export {
  RecoveryService,
  type RecoveryOptions,
  type RecoveryReport,
} from './operations/recovery.ts';
export type { CommitAuthor, GitCommitRequest, GitFile, GitStore } from './ports/git-store.ts';
export {
  sortedAliases,
  subtreeIds,
  withSubtreeStatus,
  withCategory,
  withMove,
  withUpdate,
} from './taxonomy/projection.ts';
