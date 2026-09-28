import {
  AttachmentQuery,
  AttachmentResponse,
  AttachmentsResponse,
  SingleAttachmentResponse,
  type AttachmentSummary,
  type ExtractionState,
} from '@knoverge/contracts';
import type { AttachmentRecord } from '@knoverge/core';
import { DomainError } from '@knoverge/core';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import { summary as itemSummary } from './knowledge.ts';
import { requirePermission } from '../plugins/actor-context.ts';
import { csrfUnlessBearer } from '../plugins/security.ts';
import type { Services } from '../services.ts';

function summary(attachment: AttachmentRecord): AttachmentSummary {
  return {
    id: attachment.id,
    workspace_id: attachment.workspaceId,
    content_hash: attachment.contentHash,
    media_type: attachment.mediaType,
    size_bytes: attachment.sizeBytes,
    filename: attachment.filename,
    original_uri: attachment.originalUri,
    extraction_state: attachment.extractionState as ExtractionState,
    extraction_error: attachment.extractionError,
    uploaded_by_actor_id: attachment.uploadedByActorId,
    created_at: attachment.createdAt.toISOString(),
  } as AttachmentSummary;
}

/**
 * What a browser is told to do with a file it asked for.
 *
 * Downloaded and never rendered, whatever the file is. An uploaded page served
 * inline would run on this installation's own origin, with this installation's
 * cookie — the same reason knowledge is rendered and never becomes HTML. So:
 * `attachment`, `nosniff` so the type in the header is the type that counts, and
 * a policy that allows nothing in case a browser renders it anyway.
 */
function served(reply: FastifyReply, attachment: AttachmentRecord): FastifyReply {
  const ascii = attachment.filename.replace(/[^\x20-\x7e]/gu, '_').replace(/["\\]/gu, '_');
  return reply
    .header('content-type', attachment.mediaType)
    .header('content-length', String(attachment.sizeBytes))
    .header('x-content-type-options', 'nosniff')
    .header('content-security-policy', "default-src 'none'; sandbox")
    .header(
      'content-disposition',
      `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
    );
}

/**
 * Files a workspace holds.
 *
 * `knowledge.write` to bring one in and `knowledge.read` to see or fetch one: an
 * attachment is where knowledge comes from, so it is governed by the permissions
 * over knowledge rather than by one of its own. Nothing here is an MCP tool yet —
 * an agent uploading a file raises the question of what happens to the item made
 * from it, and rule 5 says that answer is "a proposal" (Milestone 11 finishes it).
 */
export function registerAdminAttachmentRoutes(app: FastifyInstance, services: Services): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    '/v1/admin/attachments.upload',
    {
      onRequest: csrfUnlessBearer(app),
      // Multipart, so no body schema: the parser reads the parts, and what comes
      // back is checked against the contract like every other answer.
      schema: { response: { 200: AttachmentResponse } },
    },
    async (request) => {
      const actor = await requirePermission(services, request, 'knowledge.write');
      const file = await request.file();
      if (!file) {
        throw new DomainError('VALIDATION_ERROR', 'send the file as a multipart part named `file`');
      }
      const bytes = await file.toBuffer();
      // The parser stops reading at the limit and says so here rather than
      // storing a file that is missing its end.
      if (file.file.truncated) {
        throw new DomainError(
          'VALIDATION_ERROR',
          `this installation accepts files up to ${services.attachmentMaxBytes} bytes`,
        );
      }
      const original = file.fields['original_uri'];
      const result = await services.attachments.upload(actor.context, {
        filename: file.filename,
        mediaType: file.mimetype,
        bytes,
        ...(original && 'value' in original && typeof original.value === 'string'
          ? { originalUri: original.value }
          : {}),
      });
      return { attachment: summary(result.attachment), created: result.created };
    },
  );

  r.get(
    '/v1/admin/attachments.list',
    { schema: { response: { 200: AttachmentsResponse } } },
    async (request) => {
      const actor = await requirePermission(services, request, 'knowledge.read');
      const held = await services.attachments.list(actor.context.workspaceId);
      return { attachments: held.map(summary) };
    },
  );

  r.get(
    '/v1/admin/attachments.get',
    { schema: { querystring: AttachmentQuery, response: { 200: SingleAttachmentResponse } } },
    async (request) => {
      const actor = await requirePermission(services, request, 'knowledge.read');
      const attachment = await services.attachments.get(
        actor.context.workspaceId,
        request.query['attachment_id'],
      );
      // What came out of the file, read from the item's own side: the source is
      // the link, so this is the same fact the frontmatter carries.
      const items = await services.knowledge.itemsFromAttachment(actor.context, attachment.id);
      return { attachment: summary(attachment), items: items.map(itemSummary) };
    },
  );

  r.get(
    '/v1/admin/attachments.download',
    { schema: { querystring: AttachmentQuery } },
    async (request, reply) => {
      const actor = await requirePermission(services, request, 'knowledge.read');
      const { attachment, body } = await services.attachments.open(
        actor.context.workspaceId,
        request.query['attachment_id'],
      );
      return served(reply, attachment).send(body);
    },
  );
}
