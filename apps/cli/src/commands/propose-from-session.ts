import { randomUUID } from 'node:crypto';

import { Command } from 'commander';

import { proposeFromSession } from '../propose-from-session.ts';
import { emit, withServices } from '../run.ts';
import { resolveWorkspace } from '../workspace-actor.ts';

/**
 * Turning what a session found into proposals.
 *
 * Separate from `import-folder` on purpose. An inventory is a question, and
 * proposing is what somebody decides after reading the answer (ADR 0036) — so
 * the two are two commands with a person in between.
 */
export function proposeFromSessionCommand(): Command {
  return new Command('propose-from-session')
    .description('Propose the new candidates a reconciliation session found')
    .requiredOption('--session <id>', 'the session to act on')
    .requiredOption('--from <dir>', 'the folder it was taken from')
    .option('--workspace <slug>', 'which workspace')
    .option('--json', 'print the result as JSON')
    .action(async (opts: { session: string; from: string; workspace?: string; json?: boolean }) => {
      await withServices(async (services) => {
        const workspace = await resolveWorkspace(services, opts.workspace);
        const result = await proposeFromSession(services, {
          workspaceId: workspace.id,
          sessionId: opts.session,
          from: opts.from,
          requestId: randomUUID(),
        });
        emit(opts.json ?? false, result, () => [
          `${result.proposed} waiting for review`,
          ...(result.written > 0
            ? [`${result.written} written directly, because this agent's policy allows it`]
            : []),
          // Grouped, because a folder of hundreds produces the same few
          // reasons and a line each would bury them.
          ...Object.entries(
            result.skipped.reduce<Record<string, number>>((counts, skip) => {
              counts[skip.why] = (counts[skip.why] ?? 0) + 1;
              return counts;
            }, {}),
          )
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([why, count]) => `${count} left alone: ${why}`),
        ]);
      });
    });
}
