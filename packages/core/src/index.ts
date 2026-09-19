export type { ActorContext } from './actor-context.ts';
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
  MAX_CATEGORY_DEPTH,
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
  WorkspaceRecord,
  WorkspaceRepository,
} from './workspace/repository.ts';
export {
  SYSTEM_ACTOR_NAME,
  WorkspaceService,
  type CreateWorkspaceInput,
  type WorkspaceServiceOptions,
} from './workspace/service.ts';
