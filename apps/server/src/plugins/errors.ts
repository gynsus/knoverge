import type { ApiError, ErrorCode } from '@knoverge/contracts';
import { DomainError } from '@knoverge/core';
import type { FastifyError, FastifyInstance } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';

const STATUS: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
  REVISION_CONFLICT: 409,
  DUPLICATE_EXTERNAL_KEY: 409,
  DUPLICATE_SUSPECTED: 409,
  CATEGORY_CONFLICT: 409,
  PROPOSAL_ALREADY_RESOLVED: 409,
  SYNC_SESSION_EXPIRED: 410,
  POLICY_REQUIRES_REVIEW: 202,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
};

export function statusFor(code: ErrorCode): number {
  return STATUS[code];
}

/**
 * Maps every error to the shared ApiError payload (HTTP_API.md section 4).
 * Unexpected errors are logged and never leak their message.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | Error, request, reply) => {
    let body: ApiError;
    if (error instanceof DomainError) {
      body = error.toApiError();
    } else if (hasZodFastifySchemaValidationErrors(error)) {
      body = {
        code: 'VALIDATION_ERROR',
        message: error.validation
          .map((v) => `${v.instancePath || 'body'}: ${v.message}`)
          .join('; '),
        retryable: false,
      };
    } else if ('statusCode' in error && error.statusCode === 429) {
      body = { code: 'RATE_LIMITED', message: 'too many requests', retryable: true };
    } else if ('statusCode' in error && error.statusCode === 403) {
      body = { code: 'FORBIDDEN', message: 'request rejected', retryable: false };
    } else if ('statusCode' in error && error.statusCode === 413) {
      body = { code: 'VALIDATION_ERROR', message: 'request body too large', retryable: false };
    } else if (
      'statusCode' in error &&
      typeof error.statusCode === 'number' &&
      error.statusCode >= 400 &&
      error.statusCode < 500
    ) {
      // Anything the framework rejected before the handler is the caller's
      // mistake. Listing the codes one by one left the gaps as server faults:
      // a POST with no content-type is a 415, which answered INTERNAL_ERROR
      // with retryable true, telling the client to keep trying.
      body = { code: 'VALIDATION_ERROR', message: error.message, retryable: false };
    } else {
      request.log.error({ err: error }, 'unhandled error');
      body = { code: 'INTERNAL_ERROR', message: 'internal error', retryable: true };
    }
    reply.knovergeErrorCode = body.code;
    void reply.code(statusFor(body.code)).send(body);
  });
}

export const NOT_FOUND: ApiError = {
  code: 'NOT_FOUND',
  message: 'Route not found',
  retryable: false,
};
