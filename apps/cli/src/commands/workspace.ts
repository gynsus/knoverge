import { randomUUID } from 'node:crypto';

import { Command } from 'commander';

import { DomainError } from '@knoverge/core';

import { createServices } from '../services.ts';

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
        const services = createServices();
        try {
          const workspace = await services.workspaces.create({
            slug: opts.slug,
            name: opts.name,
            ...(opts.description ? { description: opts.description } : {}),
            defaultLanguage: opts.language,
            requestId: `cli:${randomUUID()}`,
          });
          console.log(`created workspace ${workspace.id} (${workspace.slug})`);
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

  cmd
    .command('list')
    .description('List workspaces')
    .action(async () => {
      const services = createServices();
      try {
        for (const ws of await services.repositories.workspaces.list()) {
          console.log(`${ws.id}\t${ws.slug}\t${ws.name}`);
        }
      } finally {
        await services.close();
      }
    });

  return cmd;
}
