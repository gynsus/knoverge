import { randomUUID } from 'node:crypto';

import { AgentId } from '@knoverge/contracts';
import { Command } from 'commander';

import { linkFromFolder } from '../link-from-folder.ts';
import { emit, parseOrFail, withServices } from '../run.ts';
import { resolveWorkspace } from '../workspace-actor.ts';

/**
 * Turning the links between imported notes into relations.
 *
 * Run after the proposals a folder produced have been accepted, because a
 * relation needs both ends to exist as items: when a note is proposed, the note
 * it links to may still be in the queue.
 */
export function linkFromFolderCommand(): Command {
  return new Command('link-from-folder')
    .description('Turn [[wikilinks]] between imported notes into relations')
    .requiredOption('--from <dir>', 'the folder the notes came from')
    .requiredOption('--agent <id>', 'the agent this arrives as; its policy decides what happens')
    .option('--workspace <slug>', 'which workspace')
    .option('--source-system <name>', 'what they were imported under (default: markdown-folder)')
    .option('--json', 'print the result as JSON')
    .action(
      async (opts: {
        from: string;
        agent: string;
        workspace?: string;
        sourceSystem?: string;
        json?: boolean;
      }) => {
        await withServices(async (services) => {
          const workspace = await resolveWorkspace(services, opts.workspace);
          const result = await linkFromFolder(services, {
            workspaceId: workspace.id,
            agentId: parseOrFail(AgentId, opts.agent, '--agent must be an agent id (ag_...)'),
            from: opts.from,
            sourceSystem: opts.sourceSystem ?? 'markdown-folder',
            requestId: randomUUID(),
          });
          emit(opts.json ?? false, result, () => [
            `${result.examined} notes examined`,
            `${result.proposed} updates waiting for review`,
            ...(result.written > 0 ? [`${result.written} written directly`] : []),
            // Grouped: a vault of hundreds produces the same few reasons, and a
            // line each would bury them.
            ...Object.entries(
              result.unresolved.reduce<Record<string, number>>((counts, link) => {
                counts[link.why] = (counts[link.why] ?? 0) + 1;
                return counts;
              }, {}),
            )
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([why, count]) => `${count} links went nowhere: ${why}`),
          ]);
        });
      },
    );
}
