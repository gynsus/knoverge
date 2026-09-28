import { sql } from 'drizzle-orm';
import { bigint, index, pgTable, text, unique, varchar } from 'drizzle-orm/pg-core';

import { id, timestampTz } from './common.ts';
import { actors } from './actors.ts';
import { workspaces } from './workspaces.ts';

/**
 * A file this workspace holds (ADR 0008).
 *
 * The bytes live on the filesystem under their own hash; this row is everything
 * else about them — what they were called, what they are, where they came from,
 * and what became of the text inside. It is not knowledge: what the file says
 * becomes a `document` item, and that item carries a source naming this
 * attachment. The source is the link, in one place and in the file itself.
 *
 * Unique per workspace by content hash, so the same file uploaded twice is one
 * row. Deduplication stops at the workspace boundary on purpose: one workspace
 * must not learn that another holds a file by uploading it and being told it was
 * already there.
 */
export const attachments = pgTable(
  'attachments',
  {
    id: id('id').primaryKey(),
    workspaceId: id('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** `sha256:<hex>` of the bytes, which is also where the file is kept. */
    contentHash: varchar('content_hash', { length: 80 }).notNull(),
    mediaType: varchar('media_type', { length: 160 }).notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    /** What it was called when it arrived. Never where it is kept. */
    filename: text('filename').notNull(),
    /** Where it came from, when the uploader said so. */
    originalUri: text('original_uri'),
    /** pending | extracted | unsupported | failed. */
    extractionState: varchar('extraction_state', { length: 16 }).notNull().default('pending'),
    /** What went wrong, when extraction failed. Never the file's contents. */
    extractionError: text('extraction_error'),
    /**
     * When a worker took this file to read it.
     *
     * The claim is the state change — one statement moves a row from `pending` to
     * `extracting` — so two workers cannot write the same document twice. This is
     * how a worker that died is noticed: a row left `extracting` is claimed again.
     */
    extractionStartedAt: timestampTz('extraction_started_at'),
    uploadedByActorId: id('uploaded_by_actor_id')
      .notNull()
      .references(() => actors.id),
    createdAt: timestampTz('created_at').notNull(),
  },
  (t) => [
    unique('attachments_workspace_content_key').on(t.workspaceId, t.contentHash),
    index('attachments_workspace_idx').on(t.workspaceId),
    // The sweep's own index: what has not been read yet, oldest first.
    index('attachments_unread_idx')
      .on(t.createdAt)
      .where(sql`${t.extractionState} IN ('pending', 'extracting')`),
  ],
);
