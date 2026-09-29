import { Command } from 'commander';

import pkg from '../package.json' with { type: 'json' };
import { agentCommand } from './commands/agent.ts';
import { auditCommand } from './commands/audit.ts';
import { backupCommand } from './commands/backup.ts';
import { exportCommand } from './commands/export.ts';
import { importCommand } from './commands/import.ts';
import { importFolderCommand } from './commands/import-folder.ts';
import { proposeFromSessionCommand } from './commands/propose-from-session.ts';
import { bootstrapCommand } from './commands/bootstrap.ts';
import { dbCommand } from './commands/db.ts';
import { integrityCommand } from './commands/integrity.ts';
import { ledgerCommand } from './commands/ledger.ts';
import { mcpCommand } from './commands/mcp.ts';
import { permissionsCommand } from './commands/permissions.ts';
import { restoreCommand } from './commands/restore.ts';
import { taxonomyCommand } from './commands/taxonomy.ts';
import { userCommand } from './commands/user.ts';
import { workspaceCommand } from './commands/workspace.ts';

const program = new Command();

program
  .name('knoverge')
  .description('Knoverge command line.')
  // The tag a release image was built from, and the source tree's own number
  // outside one. A released binary reporting 0.0.0 would make every release
  // indistinguishable from every other.
  .version(process.env['KNOVERGE_VERSION'] ?? pkg.version, '-v, --version');

program.addCommand(agentCommand());
program.addCommand(auditCommand());
program.addCommand(backupCommand());
program.addCommand(exportCommand());
program.addCommand(importCommand());
program.addCommand(importFolderCommand());
program.addCommand(proposeFromSessionCommand());
program.addCommand(bootstrapCommand());
program.addCommand(dbCommand());
program.addCommand(workspaceCommand());
program.addCommand(integrityCommand());
program.addCommand(ledgerCommand());
program.addCommand(mcpCommand());
program.addCommand(permissionsCommand());
program.addCommand(restoreCommand());
program.addCommand(taxonomyCommand());
program.addCommand(userCommand());

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
