import { z } from 'zod';

/**
 * Stable machine-readable error codes shared by MCP and HTTP. See CLAUDE.md.
 */
export const ErrorCode = z.enum([
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION_ERROR',
  'REVISION_CONFLICT',
  'DUPLICATE_EXTERNAL_KEY',
  'DUPLICATE_SUSPECTED',
  'CATEGORY_CONFLICT',
  'PROPOSAL_ALREADY_RESOLVED',
  'SYNC_SESSION_EXPIRED',
  'POLICY_REQUIRES_REVIEW',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/**
 * Error payload returned by every tool on both transports.
 */
export const ApiError = z.object({
  code: ErrorCode,
  message: z.string().min(1),
  retryable: z.boolean(),
  object_ids: z.record(z.string(), z.string().nullable()).optional(),
  current: z
    .object({
      revision_id: z.string(),
      content_hash: z.string(),
    })
    .optional(),
});
export type ApiError = z.infer<typeof ApiError>;
