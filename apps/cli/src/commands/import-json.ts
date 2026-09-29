import { randomUUID } from 'node:crypto';

import { AgentId } from '@knoverge/contracts';
import { Command } from 'commander';

import { importJson } from '../import-json.ts';
import { emit, parseOrFail, withServices } from '../run.ts';
import { resolveWorkspace } from '../workspace-actor.ts';

/**
 * A JSON export, offered to a workspace.
 *
 * The path for everything nobody wrote a parser for: a Notion export, a wiki
 * dump, somebody's script. It arrives the way every importer does — a session,
 * an inventory, an answer per candidate (ADR 0036).
 */
export function importJsonCommand(): Command {
  return new Command('import-json')
    .description('Offer the records in a JSON file to a workspace as a reconciliation session')
    .requiredOption('--file <path>', 'the JSON file to read')
    .requiredOption('--agent <id>', 'the agent this arrives as; its policy decides what happens')
    .option('--workspace <slug>', 'which workspace')
    .option('--source-system <name>', 'what produced this file (default: json-export)')
    .option('--namespace <name>', 'which export this is (default: the path given)')
    .option('--json', 'print the result as JSON')
    .action(
      async (opts: {
        file: string;
        agent: string;
        workspace?: string;
        sourceSystem?: string;
        namespace?: string;
        json?: boolean;
      }) => {
        await withServices(async (services) => {
          const workspace = await resolveWorkspace(services, opts.workspace);
          const result = await importJson(services, {
            workspaceId: workspace.id,
            agentId: parseOrFail(AgentId, opts.agent, '--agent must be an agent id (ag_...)'),
            file: opts.file,
            sourceSystem: opts.sourceSystem ?? 'json-export',
            namespace: opts.namespace ?? opts.file,
            requestId: randomUUID(),
          });
          emit(opts.json ?? false, result, () => [
            `session ${result.sessionId}`,
            `${result.read} records read, ${result.submitted} offered`,
            ...(result.skipped > 0
              ? [`${result.skipped} left out: no title or no body, so not knowledge`]
              : []),
            // Worth saying every time it happens: a positional key is stable
            // only while the file is, and a second run on a changed export
            // would not recognise them.
            ...(result.positional > 0
              ? [`${result.positional} have no id of their own and are keyed by position`]
              : []),
            ...Object.entries(result.classifications)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([classification, count]) => `${classification}\t${count}`),
            'nothing has been written; read the session and decide what to propose',
          ]);
        });
      },
    );
}
