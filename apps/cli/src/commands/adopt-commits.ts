import { Command } from 'commander';

import { emit, withServices } from '../run.ts';
import { resolveWorkspace, systemActorContext } from '../workspace-actor.ts';

/**
 * Taking in what somebody committed to the repository by hand.
 *
 * Rule 1 says the knowledge is editable without this product, and this is the
 * command that makes that true rather than nearly true: the database catches up
 * to what the repository says, instead of `integrity check` reporting
 * `head_unknown` and leaving the workspace in a state nobody can resolve
 * (ADR 0037).
 */
export function adoptCommitsCommand(): Command {
  return new Command('adopt-commits')
    .description('Record the revisions in commits made outside this product')
    .option('--workspace <slug>', 'which workspace')
    .option('--json', 'print the result as JSON')
    .action(async (opts: { workspace?: string; json?: boolean }) => {
      await withServices(async (services) => {
        const workspace = await resolveWorkspace(services, opts.workspace);
        const actor = await systemActorContext(services, workspace.id);
        const result = await services.adopt.run(workspace.id, actor);
        emit(opts.json ?? false, result, () => [
          result.commits === 0
            ? 'nothing to adopt: every commit is already recorded'
            : `${result.commits} commits adopted`,
          ...(result.created > 0 ? [`${result.created} items created`] : []),
          ...(result.updated > 0 ? [`${result.updated} items updated`] : []),
          // Named, because each is a file somebody wrote that this could not
          // read, and they are the ones a person has to go and look at.
          ...result.skipped.map((skip) => `${skip.path}\t${skip.why}`),
        ]);
      });
    });
}
