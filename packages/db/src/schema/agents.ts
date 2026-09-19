import { index, pgTable, text, uniqueIndex, varchar } from 'drizzle-orm/pg-core';

import { actors } from './actors.ts';
import { id, json, timestampTz } from './common.ts';
import { workspaces } from './workspaces.ts';

export const agents = pgTable(
  'agents',
  {
    id: id('id').primaryKey(),
    workspaceId: id('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    actorId: id('actor_id')
      .notNull()
      .references(() => actors.id),
    name: varchar('name', { length: 120 }).notNull(),
    description: text('description'),
    clientType: varchar('client_type', { length: 64 }),
    trustTier: varchar('trust_tier', { length: 16 }).notNull().default('propose'),
    status: varchar('status', { length: 16 }).notNull().default('active'),
    createdByActorId: id('created_by_actor_id')
      .notNull()
      .references(() => actors.id),
    createdAt: timestampTz('created_at').notNull(),
    lastSeenAt: timestampTz('last_seen_at'),
    metadata: json('metadata').notNull().default({}),
  },
  (t) => [
    index('agents_workspace_idx').on(t.workspaceId),
    uniqueIndex('agents_workspace_name_idx').on(t.workspaceId, t.name),
  ],
);

export const agentCredentials = pgTable(
  'agent_credentials',
  {
    id: id('id').primaryKey(),
    agentId: id('agent_id')
      .notNull()
      .references(() => agents.id),
    tokenHash: varchar('token_hash', { length: 128 }).notNull().unique(),
    tokenPrefix: varchar('token_prefix', { length: 32 }).notNull(),
    label: varchar('label', { length: 120 }),
    createdByActorId: id('created_by_actor_id')
      .notNull()
      .references(() => actors.id),
    createdAt: timestampTz('created_at').notNull(),
    expiresAt: timestampTz('expires_at'),
    revokedAt: timestampTz('revoked_at'),
    lastUsedAt: timestampTz('last_used_at'),
  },
  (t) => [index('agent_credentials_agent_idx').on(t.agentId)],
);
