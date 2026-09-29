import { Command } from 'commander';

import { takeExport } from '../export.ts';
import { emit, withServices } from '../run.ts';

/**
 * Taking a workspace somewhere else.
 *
 * Not `knoverge backup`, which answers the other question — this installation
 * died, bring it back — and carries credentials, permissions and a ledger keyed
 * to this installation's key. This is the knowledge and its history, in a form
 * somebody can read with git and nothing else (ADR 0034).
 */
export function exportCommand(): Command {
  return new Command('export')
    .description('Export one workspace: its repository as a git bundle, and a manifest')
    .requiredOption('--workspace <slug>', 'which workspace')
    .requiredOption('--out <dir>', 'where to write it')
    .option('--attachments', 'carry the uploaded files as well, not only their names')
    .option('--json', 'print the result as JSON')
    .action(
      async (opts: { workspace: string; out: string; attachments?: boolean; json?: boolean }) => {
        await withServices(async (services) => {
          const workspace = await services.repositories.workspaces.findBySlug(opts.workspace);
          if (!workspace) throw new Error(`no workspace with slug ${opts.workspace}`);

          const result = await takeExport(services, {
            workspaceId: workspace.id,
            into: opts.out,
            withAttachments: opts.attachments ?? false,
          });
          emit(opts.json ?? false, result, () => [
            `exported ${result.manifest.workspace.slug} to ${result.path}`,
            `${result.manifest.counts.items} items, ledger sequence ${result.manifest.ledger_sequence}`,
            result.attachments.copied > 0
              ? `${result.attachments.copied} attachments copied`
              : `${result.manifest.counts.attachments} attachments listed, none copied`,
            // Named rather than counted: a row whose file is not in the store is
            // the unrepairable kind, and an operator should see which.
            ...result.attachments.missing.map((id) => `missing from the store: ${id}`),
          ]);
        });
      },
    );
}
