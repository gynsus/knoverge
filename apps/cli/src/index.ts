import { Command } from 'commander';

import pkg from '../package.json' with { type: 'json' };
import { agentCommand } from './commands/agent.ts';
import { bootstrapCommand } from './commands/bootstrap.ts';
import { dbCommand } from './commands/db.ts';
import { ledgerCommand } from './commands/ledger.ts';
import { permissionsCommand } from './commands/permissions.ts';
import { taxonomyCommand } from './commands/taxonomy.ts';
import { userCommand } from './commands/user.ts';
import { workspaceCommand } from './commands/workspace.ts';

const program = new Command();

program
  .name('knoverge')
  .description('Knoverge command line.')
  .version(pkg.version, '-v, --version');

program.addCommand(agentCommand());
program.addCommand(bootstrapCommand());
program.addCommand(dbCommand());
program.addCommand(workspaceCommand());
program.addCommand(ledgerCommand());
program.addCommand(permissionsCommand());
program.addCommand(taxonomyCommand());
program.addCommand(userCommand());

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
