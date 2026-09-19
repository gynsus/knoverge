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
export { createEventRepository } from './repositories/events.ts';
export { createActorRepository, createWorkspaceRepository } from './repositories/workspaces.ts';
export * as schema from './schema/index.ts';
export { asTx, createUnitOfWork, type DrizzleTx } from './unit-of-work.ts';
