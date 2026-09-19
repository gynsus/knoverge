import { index, pgTable, primaryKey, text, varchar } from 'drizzle-orm/pg-core';

import { id, json, timestampTz } from './common.ts';
import { workspaces } from './workspaces.ts';

export const idempotencyRecords = pgTable(
  'idempotency_records',
  {
    workspaceId: id('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    actorId: id('actor_id').notNull(),
    idempotencyKey: varchar('idempotency_key', { length: 200 }).notNull(),
    requestHash: text('request_hash').notNull(),
    response: json('response').notNull(),
    createdAt: timestampTz('created_at').notNull(),
    expiresAt: timestampTz('expires_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.actorId, t.idempotencyKey] }),
    index('idempotency_records_expires_idx').on(t.expiresAt),
  ],
);
