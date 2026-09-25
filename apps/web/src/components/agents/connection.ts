import type { AgentSummary } from '@knoverge/contracts';

/**
 * What an agent's state actually is, which `status` alone does not say.
 *
 * "Registered and never connected" is not the same as "working", and both
 * were `active` before. The question somebody has after issuing a token is
 * whether the agent got in, and only this answers it.
 */
export type Connection = 'active' | 'never' | 'disabled';

export function connectionOf(agent: AgentSummary): Connection {
  if (agent.status === 'disabled') return 'disabled';
  return agent.last_seen_at === null ? 'never' : 'active';
}
