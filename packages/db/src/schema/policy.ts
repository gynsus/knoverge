import { boolean, index, integer, pgTable, varchar } from 'drizzle-orm/pg-core';

import { actors } from './actors.ts';
import { id, json, timestampTz } from './common.ts';
import { workspaces } from './workspaces.ts';

export const permissionGrants = pgTable(
  'permission_grants',
  {
    id: id('id').primaryKey(),
    workspaceId: id('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    actorId: id('actor_id')
      .notNull()
      .references(() => actors.id),
    action: varchar('action', { length: 64 }).notNull(),
    scope: json('scope').notNull().default({}),
    effect: varchar('effect', { length: 8 }).notNull().default('allow'),
    createdByActorId: id('created_by_actor_id').notNull(),
    createdAt: timestampTz('created_at').notNull(),
  },
  (t) => [index('permission_grants_workspace_actor_idx').on(t.workspaceId, t.actorId)],
);

export const policyRules = pgTable(
  'policy_rules',
  {
    id: id('id').primaryKey(),
    workspaceId: id('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    priority: integer('priority').notNull(),
    subject: json('subject').notNull(),
    action: varchar('action', { length: 64 }).notNull(),
    scope: json('scope').notNull().default({}),
    effect: varchar('effect', { length: 16 }).notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdByActorId: id('created_by_actor_id').notNull(),
    createdAt: timestampTz('created_at').notNull(),
    updatedAt: timestampTz('updated_at').notNull(),
  },
  (t) => [index('policy_rules_workspace_priority_idx').on(t.workspaceId, t.priority)],
);
