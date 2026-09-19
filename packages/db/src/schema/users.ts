import { sql } from 'drizzle-orm';
import { index, integer, pgTable, text, uniqueIndex, varchar } from 'drizzle-orm/pg-core';

import { actors } from './actors.ts';
import { id, json, timestampTz } from './common.ts';
import { workspaces } from './workspaces.ts';

export const users = pgTable(
  'users',
  {
    id: id('id').primaryKey(),
    email: varchar('email', { length: 320 }).notNull(),
    passwordHash: text('password_hash').notNull(),
    displayName: varchar('display_name', { length: 120 }).notNull(),
    locale: varchar('locale', { length: 8 }).notNull().default('en'),
    status: varchar('status', { length: 16 }).notNull().default('active'),
    mfa: json('mfa'),
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: timestampTz('locked_until'),
    passwordChangedAt: timestampTz('password_changed_at').notNull(),
    createdAt: timestampTz('created_at').notNull(),
    lastLoginAt: timestampTz('last_login_at'),
  },
  (t) => [uniqueIndex('users_email_lower_idx').on(sql`lower(${t.email})`)],
);

export const workspaceMemberships = pgTable(
  'workspace_memberships',
  {
    id: id('id').primaryKey(),
    workspaceId: id('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    userId: id('user_id')
      .notNull()
      .references(() => users.id),
    role: varchar('role', { length: 16 }).notNull(),
    actorId: id('actor_id')
      .notNull()
      .references(() => actors.id),
    createdAt: timestampTz('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('workspace_memberships_workspace_user_idx').on(t.workspaceId, t.userId),
    index('workspace_memberships_user_idx').on(t.userId),
  ],
);

export const humanSessions = pgTable(
  'human_sessions',
  {
    id: id('id').primaryKey(),
    userId: id('user_id')
      .notNull()
      .references(() => users.id),
    tokenHash: varchar('token_hash', { length: 128 }).notNull().unique(),
    createdAt: timestampTz('created_at').notNull(),
    expiresAt: timestampTz('expires_at').notNull(),
    revokedAt: timestampTz('revoked_at'),
    userAgent: text('user_agent'),
    ip: varchar('ip', { length: 64 }),
  },
  (t) => [index('human_sessions_user_idx').on(t.userId)],
);
