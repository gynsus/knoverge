import { CategoryId } from '@knoverge/contracts';
import { Command } from 'commander';

import { emit, field, parseOrFail, withServices } from '../run.ts';
import { systemActorContext } from '../workspace-actor.ts';

const CATEGORY_ID = 'must be a category id, as `taxonomy list` prints in the second column';

export function taxonomyCommand(): Command {
  const cmd = new Command('taxonomy').description('Category tree of a workspace');

  cmd
    .command('list')
    .description('Print the category tree')
    .option('--workspace <slug|id>')
    .option('--include-archived')
    .option('--tree', 'indent names to show the hierarchy; not machine readable')
    .option('--json', 'print the result as JSON')
    .action(
      async (opts: {
        workspace?: string;
        includeArchived?: boolean;
        tree?: boolean;
        json?: boolean;
      }) => {
        await withServices(async (services) => {
          const actor = await systemActorContext(services, opts.workspace);
          const version = await services.taxonomy.currentVersion(actor.workspaceId);
          // The version is context, not a row: on stdout it would be the first
          // line a script tries to split into fields.
          if (!opts.json) console.error(`taxonomy version ${version}`);
          const categories = await services.taxonomy.list(actor.workspaceId, {
            includeArchived: opts.includeArchived ?? false,
          });
          // The same field names the HTTP API uses. A second spelling of the
          // same record would be a second contract nobody documented.
          const rows = categories.map((c) => ({
            id: c.id,
            parent_id: c.parentId,
            slug: c.slug,
            path: c.path,
            name: c.name,
            status: c.status,
            aliases: c.aliases,
          }));
          emit(opts.json ?? false, { taxonomy_version: version, categories: rows }, () =>
            categories.map((category) => {
              // Indentation only with --tree: it is part of the first field, so
              // a script cannot tell a name from its depth.
              const indent = opts.tree ? '  '.repeat(category.path.split('/').length - 1) : '';
              return [
                `${indent}${field(category.name)}`,
                field(category.id),
                field(category.path),
                category.status,
                category.aliases.map(field).join(','),
              ].join('\t');
            }),
          );
        });
      },
    );

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
          parseOrFail(CategoryId, opts.category, `--category ${CATEGORY_ID}`),
          opts.parent ? parseOrFail(CategoryId, opts.parent, `--parent ${CATEGORY_ID}`) : null,
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
        const result = await services.taxonomy.archive(
          actor,
          parseOrFail(CategoryId, opts.category, `--category ${CATEGORY_ID}`),
        );
        console.log(
          `archived ${result.category.path} (taxonomy version ${result.taxonomyVersion})`,
        );
      });
    });

  cmd
    .command('restore')
    .description('Bring an archived category and its descendants back')
    .requiredOption('--category <id>')
    .option('--workspace <slug|id>')
    .action(async (opts: { category: string; workspace?: string }) => {
      await withServices(async (services) => {
        const actor = await systemActorContext(services, opts.workspace);
        const result = await services.taxonomy.restore(
          actor,
          parseOrFail(CategoryId, opts.category, `--category ${CATEGORY_ID}`),
        );
        console.log(
          `restored ${result.category.path} (taxonomy version ${result.taxonomyVersion})`,
        );
      });
    });

  return cmd;
}
