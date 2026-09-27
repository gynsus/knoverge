import { EventType } from '@knoverge/contracts';

/**
 * The event types a reader groups them into, which is not how they are named.
 *
 * Forty types in a select is a list nobody reads. These are the questions
 * somebody actually arrives with — what happened to the knowledge, what is
 * waiting on a decision, how the tree changed, what the agents did, who may do
 * what — and each is a set rather than a prefix, because
 * `knowledge.proposed_create` belongs with the proposals and not with the
 * knowledge.
 */
export const GROUPS = ['all', 'knowledge', 'proposals', 'taxonomy', 'sync', 'access'] as const;
export type Group = (typeof GROUPS)[number];

const MEMBERS: Record<Exclude<Group, 'all'>, (type: string) => boolean> = {
  knowledge: (t) =>
    (t.startsWith('knowledge.') && !t.startsWith('knowledge.proposed_')) ||
    t.startsWith('relation.') ||
    t.startsWith('summary.') ||
    t.startsWith('attachment.'),
  proposals: (t) =>
    t.startsWith('proposal.') ||
    t.startsWith('knowledge.proposed_') ||
    t === 'category.proposed' ||
    t === 'command.denied',
  taxonomy: (t) => t.startsWith('category.') && t !== 'category.proposed',
  sync: (t) => t.startsWith('sync.'),
  access: (t) =>
    t.startsWith('agent.') ||
    t.startsWith('permission.') ||
    t.startsWith('policy.') ||
    t.startsWith('membership.') ||
    t.startsWith('user.') ||
    t.startsWith('workspace.') ||
    t.startsWith('webhook.') ||
    t.startsWith('integrity.'),
};

/**
 * The types a group asks for. Empty for `all`, which asks for no filter.
 *
 * Every type belongs to exactly one group, and a test holds that: a type in no
 * group is one the filters quietly hide, and a type in two is one whose count
 * a reader sees twice.
 */
export function typesIn(group: Group): EventType[] {
  if (group === 'all') return [];
  return EventType.options.filter((type) => MEMBERS[group](type));
}
