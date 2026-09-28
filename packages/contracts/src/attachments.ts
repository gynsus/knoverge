import { z } from 'zod';

import { ActorId, AttachmentId, KnowledgeItemId, WorkspaceId } from './ids.ts';

/**
 * What became of the text inside a file.
 *
 * `pending` until the extraction job has looked at it, and `unsupported` for a
 * file this installation cannot read text out of — an image today, an archive
 * always. Neither is a failure: the file is kept and referred to, which is what
 * ADR 0008 says happens to anything that cannot be interpreted.
 */
export const ExtractionState = z.enum(['pending', 'extracted', 'unsupported', 'failed']);
export type ExtractionState = z.infer<typeof ExtractionState>;

/**
 * A file this workspace holds.
 *
 * Stored by the hash of its contents, so the same file uploaded twice is one
 * file with one id (ADR 0008). It is not knowledge: what the file *says* becomes
 * a `document` item, and this row is where that text came from.
 */
export const AttachmentSummary = z.object({
  id: AttachmentId,
  workspace_id: WorkspaceId,
  /** `sha256:<hex>` of the bytes, which is also where the file is kept. */
  content_hash: z.string(),
  media_type: z.string(),
  size_bytes: z.number().int().nonnegative(),
  /** What it was called when it arrived. Never where it is kept. */
  filename: z.string(),
  /** Where it came from, when the uploader said: a URL, a path, a message. */
  original_uri: z.string().nullable(),
  extraction_state: ExtractionState,
  /** What went wrong, when extraction failed. */
  extraction_error: z.string().nullable(),
  /** The `document` item made from its text, once there is one. */
  document_item_id: KnowledgeItemId.nullable(),
  uploaded_by_actor_id: ActorId,
  created_at: z.iso.datetime({ offset: true }),
});
export type AttachmentSummary = z.infer<typeof AttachmentSummary>;

export const AttachmentResponse = z.object({
  attachment: AttachmentSummary,
  /**
   * Whether this upload is what put the file here.
   *
   * False when the bytes were already held: the answer is the attachment that
   * exists rather than a second one, and an uploader who expected a new id
   * should be told which it is (ADR 0008 deduplicates by content).
   */
  created: z.boolean(),
});
export type AttachmentResponse = z.infer<typeof AttachmentResponse>;

/** One of them, read back. An upload's answer says more; a read has nothing to add. */
export const SingleAttachmentResponse = z.object({ attachment: AttachmentSummary });
export type SingleAttachmentResponse = z.infer<typeof SingleAttachmentResponse>;

export const AttachmentsResponse = z.object({ attachments: z.array(AttachmentSummary) });
export type AttachmentsResponse = z.infer<typeof AttachmentsResponse>;

export const AttachmentQuery = z.object({ attachment_id: AttachmentId });
export type AttachmentQuery = z.infer<typeof AttachmentQuery>;
