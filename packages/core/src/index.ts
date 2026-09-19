export type { ActorContext } from './actor-context.ts';
export { DomainError, type DomainErrorOptions } from './errors.ts';
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
