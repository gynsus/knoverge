import type { WorkspaceId } from '@knoverge/contracts';
import type { VerifyResult } from '@knoverge/core';
import { Command } from 'commander';

import { emit, withServices } from '../run.ts';
import { resolveWorkspace } from '../workspace-actor.ts';

export function ledgerCommand(): Command {
  const cmd = new Command('ledger').description('Event ledger integrity');

  cmd
    .command('verify')
    .description('Recompute the hash chain of a workspace (or every workspace)')
    .option('--workspace <slug|id>', 'omit to verify all')
    .option('--json', 'print the result as JSON')
    .action(async (opts: { workspace?: string; json?: boolean }) => {
      await withServices(async (services) => {
        const targets = opts.workspace
          ? [(await resolveWorkspace(services, opts.workspace)).id]
          : (await services.repositories.workspaces.list()).map((w) => w.id);
        const results: (VerifyResult & { workspace_id: WorkspaceId })[] = [];
        for (const id of targets) {
          results.push({ workspace_id: id, ...(await services.ledger.verify(id)) });
        }
        emit(opts.json ?? false, { results }, () =>
          results.map((r) =>
            r.ok
              ? [r.workspace_id, 'ok', String(r.count)].join('\t')
              : [r.workspace_id, 'broken', String(r.count)].join('\t'),
          ),
        );
        // What went wrong is not part of the data a script reads.
        for (const r of results) {
          if (!r.ok) {
            console.error(
              `${r.workspace_id}: broken at sequence ${r.brokenAt}: ${r.reason} (${r.count} verified)`,
            );
          }
        }
        if (results.some((r) => !r.ok)) process.exitCode = 1;
      });
    });

  return cmd;
}
