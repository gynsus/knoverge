import type {
  AttachmentId,
  ExtractionState,
  KnowledgeItemId,
  WorkspaceId,
} from '@knoverge/contracts';
import type { ActorId } from '@knoverge/contracts';
import type { AttachmentRecord, AttachmentRepository, Tx } from '@knoverge/core';
import { and, desc, eq } from 'drizzle-orm';

import type { Database } from '../client.ts';
import { attachments } from '../schema/attachments.ts';
import { asTx } from '../unit-of-work.ts';

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
    documentItemId: row.documentItemId as KnowledgeItemId | null,
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
        documentItemId: attachment.documentItemId,
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
