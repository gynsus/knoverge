import { randomUUID } from 'node:crypto';

import { Command } from 'commander';

import { emit, field, withServices } from '../run.ts';

export function workspaceCommand(): Command {
  const cmd = new Command('workspace').description('Workspace administration');

  cmd
    .command('create')
    .description('Create a workspace, with an owner unless one is refused')
    .requiredOption('--slug <slug>', 'URL-safe identifier, e.g. personal')
    .requiredOption('--name <name>', 'display name')
    .option('--description <text>')
    .option('--language <tag>', 'default content language', 'en')
    .option('--owner <email>', 'an existing account to own it')
    .action(
      async (opts: {
        slug: string;
        name: string;
        description?: string;
        language: string;
        owner?: string;
      }) => {
        await withServices(async (services) => {
          const input = {
            slug: opts.slug,
            name: opts.name,
            ...(opts.description ? { description: opts.description } : {}),
            defaultLanguage: opts.language,
            requestId: `cli:${randomUUID()}`,
          };

          // Without an owner the workspace has no members, and a workspace
          // with no members is reachable from nothing: the interface lists
          // what you belong to, and you belong to this one no more than
          // anybody else does.
          if (!opts.owner) {
            const workspace = await services.workspaces.create(input);
            console.log(`created workspace ${workspace.id} (${workspace.slug})`);
            console.warn(
              `warning: ${workspace.slug} has no members, so nobody can open it. ` +
                `Re-run with --owner <email>, or add one from another workspace's settings.`,
            );
            return;
          }

          const owner = await services.users.findByEmail(opts.owner);
          if (!owner) {
            // Deliberately not created here: an account needs a password, and
            // a password typed into a shell is a password in the history file.
            throw new Error(
              `no account for ${opts.owner}. Create the person first, then run this again.`,
            );
          }
          const workspace = await services.members.createWorkspace(owner, input);
          console.log(
            `created workspace ${workspace.id} (${workspace.slug}), owned by ${owner.email}`,
          );
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
