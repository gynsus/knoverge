import type { AttachmentId, ExtractionState, WorkspaceId } from '@knoverge/contracts';
import type { ActorId } from '@knoverge/contracts';
import type { AttachmentRecord, AttachmentRepository, Tx } from '@knoverge/core';
import { and, desc, eq, sql } from 'drizzle-orm';

import type { Database } from '../client.ts';
import { attachments } from '../schema/attachments.ts';
import { asTx } from '../unit-of-work.ts';

/**
 * A row as raw SQL returns it, under the column names.
 *
 * `db.execute` hands back what the database calls the columns; the mapper below
 * reads what drizzle calls them. One place to change when a column is added,
 * rather than a second mapper that could disagree with the first.
 */
function snake(row: Record<string, unknown>): typeof attachments.$inferSelect {
  return {
    id: row['id'],
    workspaceId: row['workspace_id'],
    contentHash: row['content_hash'],
    mediaType: row['media_type'],
    sizeBytes: Number(row['size_bytes']),
    filename: row['filename'],
    originalUri: row['original_uri'],
    extractionState: row['extraction_state'],
    extractionError: row['extraction_error'],
    extractionStartedAt: row['extraction_started_at'],
    uploadedByActorId: row['uploaded_by_actor_id'],
    createdAt: row['created_at'],
  } as typeof attachments.$inferSelect;
}

function toRecord(row: typeof attachments.$inferSelect): AttachmentRecord {
  return {
    id: row.id as AttachmentId,
    workspaceId: row.workspaceId as WorkspaceId,
    contentHash: row.contentHash,
    mediaType: row.mediaType,
    sizeBytes: row.sizeBytes,
    filename: row.filename,
    originalUri: row.originalUri,
    extractionState: row.extractionState as ExtractionState,
    extractionError: row.extractionError,
    extractionStartedAt: row.extractionStartedAt,
    uploadedByActorId: row.uploadedByActorId as ActorId,
    createdAt: row.createdAt,
  };
}

export function createAttachmentRepository(db: Database): AttachmentRepository {
  return {
    async insert(tx: Tx, attachment: AttachmentRecord) {
      await asTx(tx).insert(attachments).values({
        id: attachment.id,
        workspaceId: attachment.workspaceId,
        contentHash: attachment.contentHash,
        mediaType: attachment.mediaType,
        sizeBytes: attachment.sizeBytes,
        filename: attachment.filename,
        originalUri: attachment.originalUri,
        extractionState: attachment.extractionState,
        extractionError: attachment.extractionError,
        extractionStartedAt: attachment.extractionStartedAt,
        uploadedByActorId: attachment.uploadedByActorId,
        createdAt: attachment.createdAt,
      });
    },

    async findById(workspaceId: WorkspaceId, id: AttachmentId) {
      const [row] = await db
        .select()
        .from(attachments)
        .where(and(eq(attachments.workspaceId, workspaceId), eq(attachments.id, id)))
        .limit(1);
      return row ? toRecord(row) : null;
    },

    async findByHash(workspaceId: WorkspaceId, contentHash: string) {
      const [row] = await db
        .select()
        .from(attachments)
        .where(
          and(eq(attachments.workspaceId, workspaceId), eq(attachments.contentHash, contentHash)),
        )
        .limit(1);
      return row ? toRecord(row) : null;
    },

    async claimUnread(limit: number, staleBefore: Date, now: Date) {
      // One statement: the rows are chosen, locked and marked as being read
      // together, so a second worker sweeping the same minute finds none of them.
      // `SKIP LOCKED` rather than waiting, because a worker that waits for
      // another worker's row would then do the work twice over.
      const rows = await db.execute<typeof attachments.$inferSelect>(sql`
        UPDATE ${attachments}
        SET extraction_state = 'extracting', extraction_started_at = ${now}
        WHERE id IN (
          SELECT id FROM ${attachments}
          WHERE extraction_state = 'pending'
             OR (extraction_state = 'extracting' AND extraction_started_at < ${staleBefore})
          ORDER BY created_at ASC, id ASC
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING *
      `);
      return rows.rows.map((row) => toRecord(snake(row as Record<string, unknown>)));
    },

    async setExtraction(
      workspaceId: WorkspaceId,
      id: AttachmentId,
      state: ExtractionState,
      error: string | null,
    ) {
      await db
        .update(attachments)
        .set({ extractionState: state, extractionError: error })
        .where(and(eq(attachments.workspaceId, workspaceId), eq(attachments.id, id)));
    },

    async list(workspaceId: WorkspaceId, limit = 200) {
      const rows = await db
        .select()
        .from(attachments)
        .where(eq(attachments.workspaceId, workspaceId))
        // Newest first: a list of files is read from the end somebody just added.
        .orderBy(desc(attachments.createdAt), desc(attachments.id))
        .limit(limit);
      return rows.map(toRecord);
    },
  };
}
