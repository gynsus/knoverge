import { Command } from 'commander';

import pkg from '../package.json' with { type: 'json' };

const program = new Command();

program
  .name('knoverge')
  .description('Knoverge command line. Commands arrive with the milestones that need them.')
  .version(pkg.version, '-v, --version');

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
