import type { WorkspaceId } from '@knoverge/contracts';
import { Command } from 'commander';

import { emit, field, withServices } from '../run.ts';
import { resolveWorkspace } from '../workspace-actor.ts';

export function integrityCommand(): Command {
  const cmd = new Command('integrity').description('Whether the two stores still agree');

  cmd
    .command('check')
    .description('Compare the repository with the database, workspace by workspace')
    .option('--workspace <slug|id>', 'omit to check all')
    .option('--json', 'print the report as JSON')
    .action(async (opts: { workspace?: string; json?: boolean }) => {
      await withServices(async (services) => {
        const only: WorkspaceId[] | undefined = opts.workspace
          ? [(await resolveWorkspace(services, opts.workspace)).id]
          : undefined;
        const report = await services.integrity.check(only);
        emit(opts.json ?? false, report, () => [
          ...report.workspaces.map((w) =>
            [
              w.slug,
              `${w.items} items`,
              `${w.events} events`,
              `${w.findings.length} findings`,
            ].join('\t'),
          ),
          ...report.findings.map((f) => [f.kind, field(f.objectId), field(f.detail)].join('\t')),
        ]);
        if (!report.ok) {
          // Non-zero, so a scheduled check is a check rather than a log line. The
          // deployment guide runs this after a restore for exactly that reason.
          console.error(`${report.findings.length} finding(s); the stores do not agree`);
          process.exitCode = 1;
        }
      });
    });

  return cmd;
}
