import { describe, expect, it } from 'vitest';

import { agentCommand } from '../src/commands/agent.ts';
import { bootstrapCommand } from '../src/commands/bootstrap.ts';
import { dbCommand } from '../src/commands/db.ts';
import { ledgerCommand } from '../src/commands/ledger.ts';
import { taxonomyCommand } from '../src/commands/taxonomy.ts';
import { workspaceCommand } from '../src/commands/workspace.ts';

/** The surface the deployment guide tells operators to use. */
const EXPECTED: Record<string, string[]> = {
  agent: ['create', 'list', 'disable', 'token'],
  bootstrap: [],
  db: ['migrate', 'status'],
  ledger: ['verify'],
  taxonomy: ['list', 'create', 'move', 'archive'],
  workspace: ['create', 'list'],
};

const commands = [
  agentCommand(),
  bootstrapCommand(),
  dbCommand(),
  ledgerCommand(),
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
