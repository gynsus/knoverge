import type {
  ActorId,
  AttachmentId,
  ExtractionState,
  KnowledgeItemId,
  WorkspaceId,
} from '@knoverge/contracts';

import type { Tx } from '../ports/unit-of-work.ts';

/**
 * A file a workspace holds, as the database keeps it.
 *
 * The bytes are not here: they are on the filesystem under `contentHash`, which
 * is the only place they are (ADR 0008). This row is what the file was called,
 * what it is, where it came from and what became of the text inside it.
 */
export interface AttachmentRecord {
  id: AttachmentId;
  workspaceId: WorkspaceId;
  /** `sha256:<hex>` of the bytes. */
  contentHash: string;
  mediaType: string;
  sizeBytes: number;
  filename: string;
  originalUri: string | null;
  extractionState: ExtractionState;
  extractionError: string | null;
  /** The `document` item made from the text inside, once there is one. */
  documentItemId: KnowledgeItemId | null;
  uploadedByActorId: ActorId;
  createdAt: Date;
}

export interface AttachmentRepository {
  insert(tx: Tx, attachment: AttachmentRecord): Promise<void>;
  findById(workspaceId: WorkspaceId, id: AttachmentId): Promise<AttachmentRecord | null>;
  /** The one holding these bytes, which is how a second upload finds the first. */
  findByHash(workspaceId: WorkspaceId, contentHash: string): Promise<AttachmentRecord | null>;
  list(workspaceId: WorkspaceId, limit?: number): Promise<AttachmentRecord[]>;
}
