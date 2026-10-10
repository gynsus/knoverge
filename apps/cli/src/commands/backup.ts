import { systemTools, takeBackup } from '@knoverge/backups';
import { Command } from 'commander';

import { backupSource } from '../backup.ts';
import { emit, withServices } from '../run.ts';

/** What the setting defaults to, so the two ways of taking a copy agree. */
const DEFAULT_RETENTION_DAYS = 14;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function backupCommand(): Command {
  return new Command('backup')
    .description('Take a consistent backup of the database and the workspace repositories')
    .option('--out <dir>', 'where to write it (default: KNOVERGE_BACKUP_DIR)')
    .option('--keep-days <days>', 'how long to keep copies here (default: 14)')
    .option('--json', 'print the result as JSON')
    .action(async (opts: { out?: string; keepDays?: string; json?: boolean }) => {
      await withServices(async (services) => {
        const into = opts.out ?? process.env['KNOVERGE_BACKUP_DIR'];
        if (!into) throw new Error('give --out or set KNOVERGE_BACKUP_DIR');
        const retentionDays = Number(opts.keepDays ?? DEFAULT_RETENTION_DAYS);
        if (!Number.isInteger(retentionDays) || retentionDays < 1) {
          throw new Error('--keep-days must be a whole number of days');
        }
        const databaseUrl = required('KNOVERGE_DATABASE_URL');
        const dataDir = required('KNOVERGE_DATA_DIR');

        const result = await takeBackup(
          backupSource(services),
          { into, dataDir, retentionDays },
          systemTools(databaseUrl),
        );
        emit(opts.json ?? false, result, () => [
          `backup written to ${result.path}`,
          ...result.workspaces.map((w) => `${w.slug}\tsequence ${w.sequence}`),
          ...result.removed.map((old) => `removed ${old}`),
        ]);
      });
    });
}
