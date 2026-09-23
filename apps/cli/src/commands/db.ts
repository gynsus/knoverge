import { Command } from 'commander';

import { emit, withServices } from '../run.ts';
import { resolveWorkspace } from '../workspace-actor.ts';

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

  db.command('prune')
    .description('Remove rows nothing reads any more, and redact old proposal text')
    .action(async () => {
      await withServices(async (services) => {
        const removed = await services.maintenance.prune();
        console.log(
          `removed ${removed.idempotencyRecords} idempotency record(s), ` +
            `${removed.sessions} session(s) and ${removed.operations} decided operation(s); ` +
            `emptied the text of ${removed.redactedProposals} resolved proposal(s)`,
        );
      });
    });

  db.command('recover')
    .description('Finish or abandon writes an interrupted process left behind')
    .option('--workspace <slug|id>', 'only this workspace; the default is every one')
    .option('--json', 'print the result as JSON')
    .action(async (opts: { workspace?: string; json?: boolean }) => {
      await withServices(async (services) => {
        // The server does this at startup, which until now was the only way to
        // do it: a write that reached Git and no further leaves its workspace
        // refusing every write, and an operator whose only remedy is a restart
        // has to take the installation down to fix one workspace.
        let reports;
        if (opts.workspace === undefined) {
          reports = await services.recovery.recoverAll();
        } else {
          const workspace = await resolveWorkspace(services, opts.workspace);
          reports = { [workspace.id]: await services.recovery.recover(workspace.id) };
        }

        const slugs = new Map(
          (await services.repositories.workspaces.list()).map((w) => [w.id as string, w.slug]),
        );
        const unresolved = Object.values(reports).flatMap((r) => r.unresolved);
        emit(opts.json ?? false, { workspaces: reports }, () => {
          const entries = Object.entries(reports);
          if (entries.length === 0) return ['nothing was left unfinished'];
          return entries.map(([workspaceId, report]) =>
            [
              slugs.get(workspaceId) ?? workspaceId,
              `examined ${report.examined}`,
              `recovered ${report.recovered.length}`,
              `abandoned ${report.failed.length}`,
              `unresolved ${report.unresolved.length}`,
            ].join('\t'),
          );
        });
        // An operator has to look at these, and a script has to be able to
        // notice that without reading the words.
        if (unresolved.length > 0) {
          const reasons = Object.assign(
            {},
            ...Object.values(reports).map((r) => r.reasons),
          ) as Record<string, string>;
          for (const id of unresolved) {
            console.error(`unresolved: ${id}: ${reasons[id] ?? 'no reason recorded'}`);
          }
          console.error('these need an operator, and may need the backup');
          process.exitCode = 1;
        }
      });
    });

  db.command('reindex')
    .description('Rebuild the search index from the repository files')
    .action(async () => {
      await withServices(async (services) => {
        for (const workspace of await services.repositories.workspaces.list()) {
          const result = await services.knowledge.reindex(workspace.id);
          console.log(
            `${workspace.slug}: indexed ${result.indexed} item(s)` +
              (result.missing > 0 ? `, ${result.missing} with no file in the repository` : ''),
          );
        }
      });
    });

  return db;
}
