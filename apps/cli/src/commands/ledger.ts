import type { WorkspaceId } from '@knoverge/contracts';
import type { VerifyResult } from '@knoverge/core';
import { Command } from 'commander';

import { fingerprint } from '@knoverge/core';

import { emit, withServices } from '../run.ts';
import { ledgerKeyring } from '../services.ts';
import { resolveWorkspace } from '../workspace-actor.ts';

export function ledgerCommand(): Command {
  const cmd = new Command('ledger').description('Event ledger integrity');

  cmd
    .command('keys')
    .description('Which ledger keys are in force, by fingerprint')
    .option('--json', 'print the result as JSON')
    .action((opts: { json?: boolean }) => {
      // Fingerprints, not keys: an operator checking that the key they think is
      // configured is the one running should not have to print it (ADR 0030).
      const ring = ledgerKeyring();
      const rows = [
        { role: 'signing' as const, fingerprint: fingerprint(ring.signing) },
        ...ring.retired.map((key) => ({ role: 'retired' as const, fingerprint: fingerprint(key) })),
      ];
      emit(opts.json ?? false, { keys: rows }, () =>
        rows.map((row) => [row.role, row.fingerprint].join('\t')),
      );
    });

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
            [
              r.workspace_id,
              r.ok ? 'ok' : 'broken',
              String(r.count),
              // Worth saying on a green result: it depended on a key the operator
              // may be about to drop, and the events it signed would stop
              // verifying if they did (ADR 0030).
              ...(r.usedRetiredKey ? ['used a retired key'] : []),
            ].join('\t'),
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
