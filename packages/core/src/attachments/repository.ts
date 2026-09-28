import type { ActorId, AttachmentId, ExtractionState, WorkspaceId } from '@knoverge/contracts';

import type { Tx } from '../ports/unit-of-work.ts';

/**
 * A file a workspace holds, as the database keeps it.
 *
 * The bytes are not here: they are on the filesystem under `contentHash`, which
 * is the only place they are (ADR 0008). This row is what the file was called,
 * what it is, where it came from and what became of the text inside it.
 *
 * What the text *became* is not here either. The item made from a file carries a
 * source naming this attachment, and that source is the link: it is canonical, it
 * is in the frontmatter, and it survives being read without this software. A
 * column pointing the other way would be the same fact in a second place, and
 * only one of the two would be right after a proposal was approved.
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
  /** When a worker took it to read it, while one has. */
  extractionStartedAt: Date | null;
  uploadedByActorId: ActorId;
  createdAt: Date;
}

export interface AttachmentRepository {
  insert(tx: Tx, attachment: AttachmentRecord): Promise<void>;
  /**
   * Takes files nobody has read yet, across every workspace, and says they are
   * being read.
   *
   * The claim is the state change and happens in one statement, so two workers
   * cannot take the same file and write the same document twice. `staleBefore`
   * is what says a worker died: anything claimed before it is taken again.
   *
   * Across workspaces because the sweep is one job for the installation, and
   * oldest first so a file uploaded an hour ago does not wait behind a stream of
   * new ones.
   */
  claimUnread(limit: number, staleBefore: Date, now: Date): Promise<AttachmentRecord[]>;
  /** What became of the text inside, and why, when the answer is a failure. */
  setExtraction(
    workspaceId: WorkspaceId,
    id: AttachmentId,
    state: ExtractionState,
    error: string | null,
  ): Promise<void>;
  /**
   * Puts files back in the queue to be read again, and says how many went.
   *
   * Only `unsupported` and `failed` ones, whichever id is asked for: a file that
   * already became an item would become a second one, and one a worker is
   * holding is not somebody else's to take. Without an id it is every such file
   * in the workspace, which is what somebody who has just assigned a model
   * means.
   */
  requeue(workspaceId: WorkspaceId, id?: AttachmentId): Promise<number>;
  findById(workspaceId: WorkspaceId, id: AttachmentId): Promise<AttachmentRecord | null>;
  /** The one holding these bytes, which is how a second upload finds the first. */
  findByHash(workspaceId: WorkspaceId, contentHash: string): Promise<AttachmentRecord | null>;
  list(workspaceId: WorkspaceId, limit?: number): Promise<AttachmentRecord[]>;
}
