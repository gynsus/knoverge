import { randomUUID } from 'node:crypto';

import { Command } from 'commander';

import { emit, field, withServices } from '../run.ts';

export function workspaceCommand(): Command {
  const cmd = new Command('workspace').description('Workspace administration');

  cmd
    .command('create')
    .description('Create a workspace with its system actor')
    .requiredOption('--slug <slug>', 'URL-safe identifier, e.g. personal')
    .requiredOption('--name <name>', 'display name')
    .option('--description <text>')
    .option('--language <tag>', 'default content language', 'en')
    .action(
      async (opts: { slug: string; name: string; description?: string; language: string }) => {
        await withServices(async (services) => {
          const workspace = await services.workspaces.create({
            slug: opts.slug,
            name: opts.name,
            ...(opts.description ? { description: opts.description } : {}),
            defaultLanguage: opts.language,
            requestId: `cli:${randomUUID()}`,
          });
          console.log(`created workspace ${workspace.id} (${workspace.slug})`);
        });
      },
    );

  cmd
    .command('list')
    .description('List workspaces')
    .option('--json', 'print the result as JSON')
    .action(async (opts: { json?: boolean }) => {
      await withServices(async (services) => {
        const all = await services.repositories.workspaces.list();
        // The same field names the HTTP API uses.
        const workspaces = all.map((ws) => ({
          id: ws.id,
          slug: ws.slug,
          name: ws.name,
          description: ws.description,
          default_language: ws.defaultLanguage,
        }));
        emit(opts.json ?? false, { workspaces }, () =>
          workspaces.map((ws) => [ws.id, field(ws.slug), field(ws.name)].join('\t')),
        );
      });
    });

  return cmd;
}
