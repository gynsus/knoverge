import { randomUUID } from 'node:crypto';

import { AgentId } from '@knoverge/contracts';
import { Command } from 'commander';

import { importFolder } from '../import-folder.ts';
import { emit, parseOrFail, withServices } from '../run.ts';
import { resolveWorkspace } from '../workspace-actor.ts';

/**
 * A folder of Markdown, offered to a workspace.
 *
 * Not `knoverge import`, which reads an export this product wrote and whose
 * items cannot collide with anything here. A folder of somebody's notes is the
 * opposite case: half of it is probably a restatement of what the workspace
 * already holds. So it arrives the way an agent arrives — a session, an
 * inventory, and an answer about each candidate (ADR 0036).
 */
export function importFolderCommand(): Command {
  return new Command('import-folder')
    .description('Offer a folder of Markdown to a workspace as a reconciliation session')
    .requiredOption('--from <dir>', 'the folder to read')
    .requiredOption('--agent <id>', 'the agent this arrives as; its policy decides what happens')
    .option('--workspace <slug>', 'which workspace')
    .option('--source-system <name>', 'what produced these files (default: markdown-folder)')
    .option('--namespace <name>', 'which folder this is (default: the path given)')
    .option('--json', 'print the result as JSON')
    .action(
      async (opts: {
        from: string;
        agent: string;
        workspace?: string;
        sourceSystem?: string;
        namespace?: string;
        json?: boolean;
      }) => {
        await withServices(async (services) => {
          const workspace = await resolveWorkspace(services, opts.workspace);
          const result = await importFolder(services, {
            workspaceId: workspace.id,
            agentId: parseOrFail(AgentId, opts.agent, '--agent must be an agent id (ag_...)'),
            from: opts.from,
            sourceSystem: opts.sourceSystem ?? 'markdown-folder',
            namespace: opts.namespace ?? opts.from,
            requestId: randomUUID(),
          });
          emit(opts.json ?? false, result, () => [
            `session ${result.sessionId}`,
            `${result.read} files read, ${result.submitted} offered`,
            ...Object.entries(result.classifications)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([classification, count]) => `${classification}\t${count}`),
            // Nothing was written: an inventory is a question, and what is done
            // with the answer is the next decision somebody makes.
            'nothing has been written; read the session and decide what to propose',
          ]);
        });
      },
    );
}
