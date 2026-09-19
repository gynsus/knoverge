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
export * as schema from './schema/index.ts';
