import { randomUUID } from 'node:crypto';

import { Command } from 'commander';

import { DomainError } from '@knoverge/core';

import { createServices } from '../services.ts';

export function bootstrapCommand(): Command {
  return new Command('bootstrap')
    .description('Create the first administrator and workspace (only while no user exists)')
    .requiredOption('--email <email>')
    .requiredOption('--name <name>', 'display name of the administrator')
    .requiredOption('--workspace-slug <slug>')
    .requiredOption('--workspace-name <name>')
    .option('--locale <locale>', 'en or ru', 'en')
    .option('--password <password>', 'read from KNOVERGE_BOOTSTRAP_PASSWORD when omitted')
    .action(
      async (opts: {
        email: string;
        name: string;
        workspaceSlug: string;
        workspaceName: string;
        locale: string;
        password?: string;
      }) => {
        const password = opts.password ?? process.env['KNOVERGE_BOOTSTRAP_PASSWORD'];
        if (!password) {
          console.error('provide --password or KNOVERGE_BOOTSTRAP_PASSWORD');
          process.exitCode = 1;
          return;
        }
        const services = createServices();
        try {
          const result = await services.bootstrap.run({
            user: { email: opts.email, password, displayName: opts.name, locale: opts.locale },
            workspace: { slug: opts.workspaceSlug, name: opts.workspaceName },
            requestId: `cli:${randomUUID()}`,
          });
          console.log(
            `created administrator ${result.user.id} and workspace ${result.workspace.id}`,
          );
        } catch (err) {
          if (err instanceof DomainError) {
            console.error(`${err.code}: ${err.message}`);
            process.exitCode = 1;
            return;
          }
          throw err;
        } finally {
          await services.close();
        }
      },
    );
}
