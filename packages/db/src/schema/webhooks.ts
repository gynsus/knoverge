import { bigint, index, integer, jsonb, pgTable, text, varchar } from 'drizzle-orm/pg-core';

import { id, timestampTz } from './common.ts';
import { workspaces } from './workspaces.ts';

/**
 * Where a workspace pushes a notification that something happened (ADR 0029).
 *
 * The secret is encrypted rather than hashed: the server signs every delivery with
 * it, so it has to be able to read it back. It is the only recoverable secret in
 * the product, and the key that opens it lives in the environment.
 */
export const webhooks = pgTable(
  'webhooks',
  {
    id: id('id').primaryKey(),
    workspaceId: id('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    /** AES-256-GCM, opened with KNOVERGE_ENCRYPTION_KEY. Never served. */
    secretCiphertext: text('secret_ciphertext').notNull(),
    /** Which event types to deliver. Empty means every type. */
    eventTypes: jsonb('event_types').notNull().default([]),
    status: varchar('status', { length: 16 }).notNull().default('active'),
    /**
     * How far down the workspace's ledger this endpoint has been told.
     *
     * The per-workspace sequence, which is gapless and ordered, so a delivery that
     * fails resends rather than skips (ADR 0010 and ADR 0029).
     */
    cursor: bigint('cursor', { mode: 'number' }).notNull().default(0),
    /** Consecutive failures, which is what the backoff is computed from. */
    failures: integer('failures').notNull().default(0),
    /** Not before this: a failing endpoint is retried, further apart each time. */
    nextAttemptAt: timestampTz('next_attempt_at'),
    lastDeliveryAt: timestampTz('last_delivery_at'),
    /** What went wrong last, for an operator reading the list. Never a secret. */
    lastError: text('last_error'),
    createdAt: timestampTz('created_at').notNull(),
    updatedAt: timestampTz('updated_at').notNull(),
  },
  (t) => [index('webhooks_workspace_idx').on(t.workspaceId)],
);
