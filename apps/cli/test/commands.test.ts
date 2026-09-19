import { describe, expect, it } from 'vitest';

import { agentCommand } from '../src/commands/agent.ts';
import { bootstrapCommand } from '../src/commands/bootstrap.ts';
import { dbCommand } from '../src/commands/db.ts';
import { ledgerCommand } from '../src/commands/ledger.ts';
import { permissionsCommand } from '../src/commands/permissions.ts';
import { taxonomyCommand } from '../src/commands/taxonomy.ts';
import { workspaceCommand } from '../src/commands/workspace.ts';

/** The surface the deployment guide tells operators to use. */
const EXPECTED: Record<string, string[]> = {
  agent: ['create', 'list', 'disable', 'token'],
  bootstrap: [],
  db: ['migrate', 'prune', 'status'],
  ledger: ['verify'],
  permissions: ['list', 'grant', 'revoke'],
  taxonomy: ['list', 'create', 'move', 'archive'],
  workspace: ['create', 'list'],
};

const commands = [
  agentCommand(),
  bootstrapCommand(),
  dbCommand(),
  ledgerCommand(),
  permissionsCommand(),
  taxonomyCommand(),
  workspaceCommand(),
];

describe('command surface', () => {
  it('registers every documented command with a description', () => {
    for (const command of commands) {
      const expected = EXPECTED[command.name()];
      expect(expected, `unexpected command ${command.name()}`).toBeDefined();
      expect(command.description()).not.toBe('');
      expect(command.commands.map((c) => c.name()).sort()).toEqual([...expected!].sort());
    }
  });

  it('nests the token commands under agent', () => {
    const token = agentCommand().commands.find((c) => c.name() === 'token')!;
    expect(token.commands.map((c) => c.name()).sort()).toEqual(['issue', 'list', 'revoke']);
  });

  it('requires the options each command cannot work without', () => {
    // `mandatory` is the flag that must be given; `required` only means the
    // flag takes a value.
    const required = (name: string, sub: string) =>
      commands
        .find((c) => c.name() === name)!
        .commands.find((c) => c.name() === sub)!
        .options.filter((o) => o.mandatory)
        .map((o) => o.long);
    expect(required('agent', 'create')).toEqual(['--name']);
    expect(required('agent', 'disable')).toEqual(['--agent']);
    expect(required('taxonomy', 'create')).toEqual(['--name']);
    expect(required('taxonomy', 'move')).toEqual(['--category']);
    expect(required('workspace', 'create')).toEqual(['--slug', '--name']);
  });

  it('never makes the bootstrap password a required flag, so it can come from the environment', () => {
    const options = bootstrapCommand().options;
    expect(options.find((o) => o.long === '--password')?.mandatory).toBeFalsy();
    expect(options.filter((o) => o.mandatory).map((o) => o.long)).toEqual([
      '--email',
      '--name',
      '--workspace-slug',
      '--workspace-name',
    ]);
  });
});

describe('output a script can read', () => {
  const listCommands = [
    ['agent', 'list'],
    ['taxonomy', 'list'],
    ['workspace', 'list'],
    ['ledger', 'verify'],
    ['permissions', 'list'],
  ] as const;

  it('offers --json wherever a command prints a list', () => {
    for (const [parent, child] of listCommands) {
      const command = commands
        .find((c) => c.name() === parent)!
        .commands.find((c) => c.name() === child)!;
      const options = command.options.map((o) => o.long);
      expect(options, `${parent} ${child}`).toContain('--json');
    }
  });

  it('accepts a slug or an id wherever a command takes a workspace', () => {
    for (const [parent, child] of listCommands) {
      const command = commands
        .find((c) => c.name() === parent)!
        .commands.find((c) => c.name() === child)!;
      const workspace = command.options.find((o) => o.long === '--workspace');
      if (!workspace) continue;
      // ledger verify used to take an id only, unlike every other command.
      expect(workspace.flags, `${parent} ${child}`).toContain('<slug|id>');
    }
  });

  it('says what an identifier option expects, rather than printing a schema', async () => {
    const { parseOrFail } = await import('../src/run.ts');
    const { AgentId } = await import('@knoverge/contracts');
    expect(() => parseOrFail(AgentId, 'not-an-id', '--agent must be an agent id')).toThrowError(
      '--agent must be an agent id',
    );
  });
});
