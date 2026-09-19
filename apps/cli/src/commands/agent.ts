import { AgentId, TrustTier } from '@knoverge/contracts';
import { DomainError } from '@knoverge/core';
import { Command } from 'commander';

import { createServices } from '../services.ts';
import { systemActorContext } from '../workspace-actor.ts';

async function withServices<T>(
  fn: (s: ReturnType<typeof createServices>) => Promise<T>,
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

export function agentCommand(): Command {
  const cmd = new Command('agent').description('Agent identities and credentials');

  cmd
    .command('create')
    .description('Register an agent')
    .requiredOption('--name <name>')
    .option('--description <text>')
    .option('--client-type <type>', 'for example claude-code')
    .option('--trust-tier <tier>', 'read_only, propose or trusted', 'propose')
    .option('--workspace <slug|id>')
    .action(
      async (opts: {
        name: string;
        description?: string;
        clientType?: string;
        trustTier: string;
        workspace?: string;
      }) => {
        await withServices(async (services) => {
          const tier = TrustTier.safeParse(opts.trustTier);
          if (!tier.success) throw new Error('trust tier must be read_only, propose or trusted');
          const actor = await systemActorContext(services, opts.workspace);
          const agent = await services.agents.create(actor, {
            name: opts.name,
            description: opts.description,
            clientType: opts.clientType,
            trustTier: tier.data,
          });
          console.log(`created agent ${agent.id} (${agent.name}, ${agent.trustTier})`);
        });
      },
    );

  cmd
    .command('list')
    .description('List agents')
    .option('--workspace <slug|id>')
    .action(async (opts: { workspace?: string }) => {
      await withServices(async (services) => {
        const actor = await systemActorContext(services, opts.workspace);
        for (const agent of await services.agents.list(actor.workspaceId)) {
          const active = await services.agents.countActiveCredentials(agent.id);
          console.log(
            `${agent.id}\t${agent.status}\t${agent.trustTier}\t${active} credential(s)\t${agent.name}`,
          );
        }
      });
    });

  cmd
    .command('disable')
    .description('Disable an agent and revoke its credentials')
    .requiredOption('--agent <id>')
    .option('--workspace <slug|id>')
    .action(async (opts: { agent: string; workspace?: string }) => {
      await withServices(async (services) => {
        const actor = await systemActorContext(services, opts.workspace);
        const agent = await services.agents.update(actor, {
          agentId: AgentId.parse(opts.agent),
          status: 'disabled',
        });
        console.log(`disabled agent ${agent.id}`);
      });
    });

  const token = new Command('token').description('Agent bearer credentials');

  token
    .command('issue')
    .description('Issue a credential; the token is printed once')
    .requiredOption('--agent <id>')
    .option('--label <text>')
    .option('--expires-in-days <days>', 'omit for a credential that does not expire')
    .option('--workspace <slug|id>')
    .action(
      async (opts: {
        agent: string;
        label?: string;
        expiresInDays?: string;
        workspace?: string;
      }) => {
        await withServices(async (services) => {
          const actor = await systemActorContext(services, opts.workspace);
          const issued = await services.agents.issueCredential(actor, {
            agentId: AgentId.parse(opts.agent),
            label: opts.label,
            ...(opts.expiresInDays ? { expiresInDays: Number(opts.expiresInDays) } : {}),
          });
          console.log(issued.token);
          console.error(
            `credential ${issued.credential.id} issued; this token is shown once and cannot be recovered`,
          );
        });
      },
    );

  token
    .command('revoke')
    .description('Revoke a credential')
    .requiredOption('--credential <id>')
    .option('--workspace <slug|id>')
    .action(async (opts: { credential: string; workspace?: string }) => {
      await withServices(async (services) => {
        const actor = await systemActorContext(services, opts.workspace);
        await services.agents.revokeCredential(actor, opts.credential);
        console.log(`revoked credential ${opts.credential}`);
      });
    });

  token
    .command('list')
    .description('List credentials of an agent')
    .requiredOption('--agent <id>')
    .option('--workspace <slug|id>')
    .action(async (opts: { agent: string; workspace?: string }) => {
      await withServices(async (services) => {
        const actor = await systemActorContext(services, opts.workspace);
        const credentials = await services.agents.listCredentials(
          actor.workspaceId,
          AgentId.parse(opts.agent),
        );
        for (const c of credentials) {
          const state = c.revokedAt
            ? 'revoked'
            : c.expiresAt && c.expiresAt <= new Date()
              ? 'expired'
              : 'active';
          console.log(`${c.id}\t${state}\t${c.tokenPrefix}\t${c.label ?? ''}`);
        }
      });
    });

  cmd.addCommand(token);
  return cmd;
}
