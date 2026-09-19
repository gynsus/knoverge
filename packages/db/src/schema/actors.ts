import { sql } from 'drizzle-orm';
import { index, pgTable, uniqueIndex, varchar } from 'drizzle-orm/pg-core';

import { id, timestampTz } from './common.ts';
import { users } from './users.ts';
import { workspaces } from './workspaces.ts';

export const actors = pgTable(
  'actors',
  {
    id: id('id').primaryKey(),
    workspaceId: id('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    type: varchar('type', { length: 16 }).notNull(),
    displayName: varchar('display_name', { length: 120 }).notNull(),
    userId: id('user_id').references(() => users.id),
    // No foreign key to agents: the actor is created first and referenced by the agent.
    agentId: id('agent_id'),
    createdAt: timestampTz('created_at').notNull(),
    disabledAt: timestampTz('disabled_at'),
  },
  (t) => [
    index('actors_workspace_idx').on(t.workspaceId),
    // One system actor per workspace.
    uniqueIndex('actors_workspace_system_idx')
      .on(t.workspaceId)
      .where(sql`type = 'system'`),
  ],
);
