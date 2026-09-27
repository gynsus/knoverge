import { Command } from 'commander';

import { systemTools, takeBackup } from '../backup.ts';
import { emit, withServices } from '../run.ts';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function backupCommand(): Command {
  return new Command('backup')
    .description('Take a consistent backup of the database and the workspace repositories')
    .option('--out <dir>', 'where to write it (default: KNOVERGE_BACKUP_DIR)')
    .option('--keep <count>', 'how many whole backups to keep (default: 14)')
    .option('--json', 'print the result as JSON')
    .action(async (opts: { out?: string; keep?: string; json?: boolean }) => {
      await withServices(async (services) => {
        const into = opts.out ?? process.env['KNOVERGE_BACKUP_DIR'];
        if (!into) throw new Error('give --out or set KNOVERGE_BACKUP_DIR');
        const keep = Number(opts.keep ?? process.env['KNOVERGE_BACKUP_KEEP'] ?? 14);
        if (!Number.isInteger(keep) || keep < 1) throw new Error('--keep must be a whole number');
        const databaseUrl = required('KNOVERGE_DATABASE_URL');
        const dataDir = required('KNOVERGE_DATA_DIR');

        const result = await takeBackup(
          services,
          { into, dataDir, keep },
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
