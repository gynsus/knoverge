import { randomUUID } from 'node:crypto';

import { Command } from 'commander';

import { runImport } from '../import.ts';
import { emit, withServices } from '../run.ts';

/**
 * Putting a workspace back from an export.
 *
 * Not `knoverge restore`, which puts this installation back from its own backup.
 * This takes a directory `knoverge export` wrote — possibly on somebody else's
 * machine — and makes a workspace here out of it (ADR 0035).
 */
export function importCommand(): Command {
  return new Command('import')
    .description('Import a workspace from an export directory')
    .requiredOption('--from <dir>', 'the export directory')
    .option('--slug <slug>', 'the slug to create it under (default: the one it came from)')
    .option('--json', 'print the result as JSON')
    .action(async (opts: { from: string; slug?: string; json?: boolean }) => {
      await withServices(async (services) => {
        const result = await runImport(services, {
          from: opts.from,
          ...(opts.slug ? { slug: opts.slug } : {}),
          requestId: randomUUID(),
        });
        emit(opts.json ?? false, result, () => [
          `imported ${result.slug} (${result.workspaceId})`,
          `${result.items} items, ${result.revisions} revisions, ${result.categories} categories`,
          `${result.actors} actors recreated, and none of them can sign in`,
          ...(result.attachments.copied > 0 ? [`${result.attachments.copied} files copied`] : []),
          // Named rather than counted: a row whose file the export did not carry
          // is one an operator has to go back for.
          ...result.attachments.withoutBytes.map((id) => `without its file: ${id}`),
          ...result.skipped.map((commit) => `could not replay: ${commit}`),
          'grant your people and agents access before anybody can use it',
        ]);
      });
    });
}
