import { Command } from 'commander';

import { createDatabase } from '@knoverge/db';
import { EventLedger, parseLedgerKey } from '@knoverge/core';
import type { WorkspaceId } from '@knoverge/contracts';

import { emit } from '../run.ts';
import { SELF, restoreBackup, restoredWell, systemTools } from '../restore.ts';
import { createRepositories } from '@knoverge/db';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/**
 * Restore is its own composition root.
 *
 * `createServices` opens a pool sized for a running server and builds services
 * that read the schema the restore is about to replace. Two connections and a
 * ledger is all this needs.
 */
export function restoreCommand(): Command {
  return new Command('restore')
    .description('Put a backup back, and check that it came back')
    .requiredOption('--from <dir>', 'a backup directory written by knoverge backup')
    .option('--force', 'replace a database that already holds knowledge')
    .option('--json', 'print the result as JSON')
    .action(async (opts: { from: string; force?: boolean; json?: boolean }) => {
      const databaseUrl = required('KNOVERGE_DATABASE_URL');
      const dataDir = required('KNOVERGE_DATA_DIR');
      // Named, and one connection: the check for other clients has to be able to
      // tell this command's own sockets from somebody else's.
      const named = new URL(databaseUrl);
      named.searchParams.set('application_name', SELF);
      const handle = createDatabase({ connectionString: named.toString(), max: 1 });
      try {
        const ledger = new EventLedger({
          key: parseLedgerKey(required('KNOVERGE_LEDGER_KEY')),
          events: createRepositories(handle.db).events,
        });
        const result = await restoreBackup(
          handle.db,
          (workspaceId) => ledger.verify(workspaceId as WorkspaceId),
          { from: opts.from, dataDir, force: opts.force ?? false },
          systemTools(databaseUrl),
        );
        emit(opts.json ?? false, result, () => [
          `restored the backup taken at ${result.manifest.takenAt}`,
          ...result.replaced.map((w) => `replaced ${w.slug}`),
          ...result.checks.map((c) =>
            [c.slug, `ledger ${c.ledger}`, `sequence ${c.actual} of ${c.expected}`].join('\t'),
          ),
        ]);
        if (!restoredWell(result)) {
          // Non-zero, because a script that restores and carries on is the
          // reason a bad restore goes unnoticed until somebody reads knowledge
          // that is not there.
          console.error('the restore did not come back whole; see the rows above');
          process.exitCode = 1;
        }
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      } finally {
        await handle.close();
      }
    });
}
