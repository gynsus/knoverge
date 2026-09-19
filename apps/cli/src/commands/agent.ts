import { AgentId, TrustTier } from '@knoverge/contracts';
import { Command } from 'commander';

import { emit, field, parseOrFail, withServices } from '../run.ts';
import { systemActorContext } from '../workspace-actor.ts';

const AGENT_ID = 'must be an agent id, as `agent list` prints in the first column';

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
          const tier = parseOrFail(
            TrustTier,
            opts.trustTier,
            '--trust-tier must be read_only, propose or trusted',
          );
          const actor = await systemActorContext(services, opts.workspace);
          const agent = await services.agents.create(
            actor,
            {},
            {
              name: opts.name,
              description: opts.description,
              clientType: opts.clientType,
              trustTier: tier,
            },
          );
          console.log(`created agent ${agent.id} (${agent.name}, ${agent.trustTier})`);
        });
      },
    );

  cmd
    .command('list')
    .description('List agents')
    .option('--workspace <slug|id>')
    .option('--json', 'print the result as JSON')
    .action(async (opts: { workspace?: string; json?: boolean }) => {
      await withServices(async (services) => {
        const actor = await systemActorContext(services, opts.workspace);
        const agents = await services.agents.list(actor.workspaceId);
        // The same field names the HTTP API uses.
        const rows = await Promise.all(
          agents.map(async (agent) => ({
            id: agent.id,
            actor_id: agent.actorId,
            name: agent.name,
            description: agent.description,
            client_type: agent.clientType,
            trust_tier: agent.trustTier,
            status: agent.status,
            active_credentials: await services.agents.countActiveCredentials(agent.id),
          })),
        );
        emit(opts.json ?? false, { agents: rows }, () =>
          rows.map((agent) =>
            [
              agent.id,
              agent.status,
              agent.trust_tier,
              String(agent.active_credentials),
              field(agent.name),
            ].join('\t'),
          ),
        );
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
        const agent = await services.agents.update(
          actor,
          {},
          {
            agentId: parseOrFail(AgentId, opts.agent, `--agent ${AGENT_ID}`),
            status: 'disabled',
          },
        );
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
            agentId: parseOrFail(AgentId, opts.agent, `--agent ${AGENT_ID}`),
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
        const changed = await services.agents.revokeCredential(actor, opts.credential);
        console.log(
          changed
            ? `revoked credential ${opts.credential}`
            : `credential ${opts.credential} was already revoked`,
        );
      });
    });

  token
    .command('list')
    .description('List credentials of an agent')
    .requiredOption('--agent <id>')
    .option('--workspace <slug|id>')
    .option('--json', 'print the result as JSON')
    .action(async (opts: { agent: string; workspace?: string; json?: boolean }) => {
      await withServices(async (services) => {
        const actor = await systemActorContext(services, opts.workspace);
        const credentials = await services.agents.listCredentials(
          actor.workspaceId,
          parseOrFail(AgentId, opts.agent, `--agent ${AGENT_ID}`),
        );
        const rows = credentials.map((c) => ({
          id: c.id,
          token_prefix: c.tokenPrefix,
          label: c.label,
          expires_at: c.expiresAt?.toISOString() ?? null,
          revoked_at: c.revokedAt?.toISOString() ?? null,
          last_used_at: c.lastUsedAt?.toISOString() ?? null,
          state: c.revokedAt
            ? 'revoked'
            : c.expiresAt && c.expiresAt <= new Date()
              ? 'expired'
              : 'active',
        }));
        emit(opts.json ?? false, { credentials: rows }, () =>
          rows.map((c) => [c.id, c.state, c.token_prefix, field(c.label)].join('\t')),
        );
      });
    });

  cmd.addCommand(token);
  return cmd;
}
