export {
  createDatabase,
  type Database,
  type DatabaseHandle,
  type DatabaseOptions,
} from './client.ts';
export {
  MIGRATIONS_SCHEMA,
  MIGRATIONS_TABLE,
  defaultMigrationsFolder,
  getMigrationStatus,
  runMigrations,
  type MigrationStatus,
  type RunMigrationsResult,
} from './migrate.ts';
export { createAgentRepository, createCredentialRepository } from './repositories/agents.ts';
export {
  createAliasRepository,
  createCategoryRepository,
  createTaxonomyVersionRepository,
} from './repositories/categories.ts';
export { createEventRepository } from './repositories/events.ts';
export {
  createPermissionGrantRepository,
  createPolicyRuleRepository,
} from './repositories/policy.ts';
export { createRepositories, type Repositories } from './repositories/index.ts';
export { createMembershipRepository } from './repositories/memberships.ts';
export { createSessionRepository } from './repositories/sessions.ts';
export { createUserRepository } from './repositories/users.ts';
export { createActorRepository, createWorkspaceRepository } from './repositories/workspaces.ts';
export * as schema from './schema/index.ts';
export { asTx, createUnitOfWork, type DrizzleTx } from './unit-of-work.ts';
