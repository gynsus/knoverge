import { CategoryId } from '@knoverge/contracts';
import { DomainError } from '@knoverge/core';
import { Command } from 'commander';

import { createServices } from '../services.ts';
import { systemActorContext } from '../workspace-actor.ts';

async function withServices(
  fn: (s: ReturnType<typeof createServices>) => Promise<void>,
): Promise<void> {
  const services = createServices();
  try {
    await fn(services);
  } catch (err) {
    if (err instanceof DomainError) {
      console.error(`${err.code}: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    if (err instanceof Error) {
      console.error(err.message);
      process.exitCode = 1;
      return;
    }
    throw err;
  } finally {
    await services.close();
  }
}

export function taxonomyCommand(): Command {
  const cmd = new Command('taxonomy').description('Category tree of a workspace');

  cmd
    .command('list')
    .description('Print the category tree')
    .option('--workspace <slug|id>')
    .option('--include-archived')
    .action(async (opts: { workspace?: string; includeArchived?: boolean }) => {
      await withServices(async (services) => {
        const actor = await systemActorContext(services, opts.workspace);
        const version = await services.taxonomy.currentVersion(actor.workspaceId);
        console.log(`taxonomy version ${version}`);
        const categories = await services.taxonomy.list(actor.workspaceId, {
          includeArchived: opts.includeArchived ?? false,
        });
        for (const category of categories) {
          const indent = '  '.repeat(category.path.split('/').length - 1);
          const aliases = category.aliases.length > 0 ? ` (${category.aliases.join(', ')})` : '';
          const status = category.status === 'active' ? '' : ` [${category.status}]`;
          console.log(
            `${indent}${category.name}${aliases}${status}\t${category.id}\t${category.path}`,
          );
        }
      });
    });

  cmd
    .command('create')
    .description('Create a category')
    .requiredOption('--name <name>')
    .option('--parent <path>', 'parent category path; omit for a root category')
    .option('--slug <slug>', 'defaults to a slug derived from the name')
    .option('--description <text>')
    .option('--alias <alias...>')
    .option('--workspace <slug|id>')
    .action(
      async (opts: {
        name: string;
        parent?: string;
        slug?: string;
        description?: string;
        alias?: string[];
        workspace?: string;
      }) => {
        await withServices(async (services) => {
          const actor = await systemActorContext(services, opts.workspace);
          const result = await services.taxonomy.create(actor, {
            name: opts.name,
            parentPath: opts.parent,
            slug: opts.slug,
            description: opts.description,
            aliases: opts.alias,
          });
          console.log(
            `created ${result.category.id} at ${result.category.path} (taxonomy version ${result.taxonomyVersion})`,
          );
        });
      },
    );

  cmd
    .command('move')
    .description('Move a category to a new parent')
    .requiredOption('--category <id>')
    .option('--parent <id>', 'new parent id; omit to make it a root category')
    .option('--workspace <slug|id>')
    .action(async (opts: { category: string; parent?: string; workspace?: string }) => {
      await withServices(async (services) => {
        const actor = await systemActorContext(services, opts.workspace);
        const result = await services.taxonomy.move(
          actor,
          CategoryId.parse(opts.category),
          opts.parent ? CategoryId.parse(opts.parent) : null,
        );
        console.log(
          `moved to ${result.category.path} (taxonomy version ${result.taxonomyVersion})`,
        );
      });
    });

  cmd
    .command('archive')
    .description('Archive a category and its descendants')
    .requiredOption('--category <id>')
    .option('--workspace <slug|id>')
    .action(async (opts: { category: string; workspace?: string }) => {
      await withServices(async (services) => {
        const actor = await systemActorContext(services, opts.workspace);
        const result = await services.taxonomy.archive(actor, CategoryId.parse(opts.category));
        console.log(
          `archived ${result.category.path} (taxonomy version ${result.taxonomyVersion})`,
        );
      });
    });

  return cmd;
}
