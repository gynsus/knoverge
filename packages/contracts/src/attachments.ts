import { z } from 'zod';

import { KnowledgeItemSummary } from './knowledge.ts';
import { ActorId, AttachmentId, WorkspaceId } from './ids.ts';

/**
 * What became of the text inside a file.
 *
 * `pending` until a worker takes it, `extracting` while one has it. `extracted` once the text
 * is a `document` item, and `proposed` when the uploader was an agent and a
 * reviewer has the text instead — an agent's file is not a way past rule 5.
 * `unsupported` is for a file this installation cannot read text out of: an image
 * today, an archive always. Neither of those is a failure — the file is kept and
 * referred to, which is what ADR 0008 says happens to anything uninterpretable.
 */
export const ExtractionState = z.enum([
  'pending',
  'extracting',
  'extracted',
  'proposed',
  'unsupported',
  'failed',
]);
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

/**
 * One of them, read back, with whatever came out of it.
 *
 * The items are the ones whose current revision rests on this file — the link is
 * the source on the item and nothing else (ADR 0008). Empty while the text is
 * still with a reviewer, which `extraction_state` is what explains.
 */
export const SingleAttachmentResponse = z.object({
  attachment: AttachmentSummary,
  items: z.array(KnowledgeItemSummary),
});
export type SingleAttachmentResponse = z.infer<typeof SingleAttachmentResponse>;

export const AttachmentsResponse = z.object({ attachments: z.array(AttachmentSummary) });
export type AttachmentsResponse = z.infer<typeof AttachmentsResponse>;

export const AttachmentQuery = z.object({ attachment_id: AttachmentId });
export type AttachmentQuery = z.infer<typeof AttachmentQuery>;

/**
 * Bringing a file in over a transport that carries JSON.
 *
 * The bytes are base64 because MCP is JSON, which costs a third of the request
 * budget in encoding alone — so the manifest reports `max_attachment_bytes`, the
 * largest file that actually fits, and a file past it goes to
 * `POST /v1/admin/attachments.upload` as multipart instead.
 */
export const UploadAttachmentInput = z.object({
  filename: z
    .string()
    .min(1)
    .max(255)
    .describe('What the file is called. A name, never a path: no slashes, no line breaks.'),
  media_type: z
    .string()
    .min(3)
    .max(160)
    .describe(
      'What the file is: `text/markdown`, `application/pdf`, `image/png`. Text, Markdown, HTML, PDF and Word documents are read into a `document` item; anything else is kept and can be downloaded.',
    ),
  content_base64: z.string().min(4).describe('The file itself, base64 encoded.'),
  original_uri: z
    .string()
    .max(2048)
    .optional()
    .describe('Where the file came from, when you know: a URL, a path, a message.'),
  request_id: z.string().max(128).optional(),
  idempotency_key: z.string().max(128).optional(),
});
export type UploadAttachmentInput = z.infer<typeof UploadAttachmentInput>;

/** Everything this workspace holds. */
export const AttachmentListInput = z.object({
  limit: z.number().int().min(1).max(200).default(50),
});
export type AttachmentListInput = z.infer<typeof AttachmentListInput>;
