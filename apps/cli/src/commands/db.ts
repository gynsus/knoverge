import { Command } from 'commander';

import {
  createDatabase,
  defaultMigrationsFolder,
  getMigrationStatus,
  runMigrations,
} from '@knoverge/db';

function connectionString(): string {
  const url = process.env['KNOVERGE_DATABASE_URL'];
  if (!url) {
    throw new Error('KNOVERGE_DATABASE_URL is required');
  }
  return url;
}

async function withDatabase<T>(fn: (db: ReturnType<typeof createDatabase>) => Promise<T>) {
  const handle = createDatabase({ connectionString: connectionString(), max: 2 });
  try {
    return await fn(handle);
  } finally {
    await handle.close();
  }
}

export function dbCommand(): Command {
  const db = new Command('db').description('Database maintenance');

  db.command('migrate')
    .description('Apply pending migrations (use with KNOVERGE_AUTO_MIGRATE=false)')
    .action(async () => {
      await withDatabase(async (handle) => {
        const result = await runMigrations(handle.db, defaultMigrationsFolder());
        const applied = result.after.applied - result.before.applied;
        console.log(
          `applied ${applied} migration(s); ${result.after.applied}/${result.after.total} up to date`,
        );
      });
    });

  db.command('status')
    .description('Show applied and pending migrations; exits 1 when any are pending')
    .action(async () => {
      await withDatabase(async (handle) => {
        const status = await getMigrationStatus(handle.db, defaultMigrationsFolder());
        console.log(`applied: ${status.applied}/${status.total}`);
        for (const tag of status.pending) {
          console.log(`pending: ${tag}`);
        }
        if (status.pending.length > 0) {
          process.exitCode = 1;
        }
      });
    });

  return db;
}
