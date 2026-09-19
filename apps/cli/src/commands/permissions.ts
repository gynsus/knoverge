import { ActorId, CategoryId, PermissionAction } from '@knoverge/contracts';
import { Command } from 'commander';

import { emit, field, parseOrFail, withServices } from '../run.ts';
import { systemActorContext } from '../workspace-actor.ts';

const ACTOR_ID = 'must be an actor id, as `permissions list` prints in the second column';

/**
 * The recovery path for permission grants.
 *
 * A grant can restrict the people who administer grants, and a restriction is
 * deliberately not lifted by the person it restricts. Without a command line
 * route in, a workspace could reach a state that needed direct SQL. These
 * commands run as the workspace's system actor, which is the host operator, and
 * are recorded in the ledger like any other change.
 */
export function permissionsCommand(): Command {
  const cmd = new Command('permissions').description('Permission grants of a workspace');

  cmd
    .command('list')
    .description('List permission grants')
    .option('--workspace <slug|id>')
    .option('--actor <id>', 'only grants for this actor')
    .option('--json', 'print the result as JSON')
    .action(async (opts: { workspace?: string; actor?: string; json?: boolean }) => {
      await withServices(async (services) => {
        const actor = await systemActorContext(services, opts.workspace);
        const subject = opts.actor
          ? parseOrFail(ActorId, opts.actor, `--actor ${ACTOR_ID}`)
          : undefined;
        const grants = await services.authorizationAdmin.listGrants(actor, subject);
        const rows = grants.map((g) => ({
          id: g.id,
          actor_id: g.actorId,
          action: g.action,
          effect: g.effect,
          scope: g.scope,
          created_at: g.createdAt.toISOString(),
        }));
        emit(opts.json ?? false, { grants: rows }, () =>
          rows.map((g) =>
            [
              g.id,
              g.actor_id,
              g.action,
              g.effect,
              field(g.scope.categories.map((c) => c.category_id).join(',')),
            ].join('\t'),
          ),
        );
      });
    });

  cmd
    .command('grant')
    .description('Add a permission grant')
    .requiredOption('--actor <id>', 'the actor the grant applies to')
    .requiredOption('--action <action>')
    .option('--effect <effect>', 'allow or deny', 'allow')
    .option('--category <id...>', 'limit the grant to these categories and their descendants')
    .option('--workspace <slug|id>')
    .action(
      async (opts: {
        actor: string;
        action: string;
        effect: string;
        category?: string[];
        workspace?: string;
      }) => {
        await withServices(async (services) => {
          const actor = await systemActorContext(services, opts.workspace);
          if (opts.effect !== 'allow' && opts.effect !== 'deny') {
            throw new Error('--effect must be allow or deny');
          }
          const grant = await services.authorizationAdmin.grant(
            actor,
            {},
            {
              actorId: parseOrFail(ActorId, opts.actor, `--actor ${ACTOR_ID}`),
              action: parseOrFail(
                PermissionAction,
                opts.action,
                '--action must be a permission action, for example taxonomy.manage',
              ),
              effect: opts.effect,
              ...(opts.category
                ? {
                    scope: {
                      categories: opts.category.map((id) => ({
                        category_id: parseOrFail(
                          CategoryId,
                          id,
                          '--category must be a category id',
                        ),
                        include_descendants: true,
                      })),
                      types: [],
                      languages: [],
                    },
                  }
                : {}),
            },
          );
          console.log(`${grant.effect} ${grant.action} for ${grant.actorId} (${grant.id})`);
        });
      },
    );

  cmd
    .command('revoke')
    .description('Remove a permission grant')
    .requiredOption('--grant <id>')
    .option('--workspace <slug|id>')
    .action(async (opts: { grant: string; workspace?: string }) => {
      await withServices(async (services) => {
        const actor = await systemActorContext(services, opts.workspace);
        await services.authorizationAdmin.revokeGrant(actor, {}, opts.grant);
        console.log(`revoked grant ${opts.grant}`);
      });
    });

  return cmd;
}
