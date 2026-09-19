import { Command } from 'commander';

import pkg from '../package.json' with { type: 'json' };
import { dbCommand } from './commands/db.ts';
import { ledgerCommand } from './commands/ledger.ts';
import { workspaceCommand } from './commands/workspace.ts';

const program = new Command();

program
  .name('knoverge')
  .description('Knoverge command line.')
  .version(pkg.version, '-v, --version');

program.addCommand(dbCommand());
program.addCommand(workspaceCommand());
program.addCommand(ledgerCommand());

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
