import { WorkspaceId } from '@knoverge/contracts';
import { Command } from 'commander';

import { createServices } from '../services.ts';

export function ledgerCommand(): Command {
  const cmd = new Command('ledger').description('Event ledger integrity');

  cmd
    .command('verify')
    .description('Recompute the hash chain of a workspace (or every workspace)')
    .option('--workspace <id>', 'workspace id; omit to verify all')
    .action(async (opts: { workspace?: string }) => {
      const services = createServices();
      try {
        const targets = opts.workspace
          ? [WorkspaceId.parse(opts.workspace)]
          : (await services.repositories.workspaces.list()).map((w) => w.id);
        let failed = 0;
        for (const id of targets) {
          const result = await services.ledger.verify(id);
          if (result.ok) {
            console.log(`${id}\tok\t${result.count} event(s)`);
          } else {
            failed += 1;
            console.log(
              `${id}\tBROKEN at sequence ${result.brokenAt}: ${result.reason} (${result.count} verified)`,
            );
          }
        }
        if (failed > 0) process.exitCode = 1;
      } finally {
        await services.close();
      }
    });

  return cmd;
}
