import type { ApiError, ErrorCode } from '@knoverge/contracts';

export interface DomainErrorOptions {
  retryable?: boolean;
  objectIds?: Record<string, string | null>;
  current?: { revision_id: string; content_hash: string };
  duplicates?: ApiError['duplicates'];
  cause?: unknown;
}

/**
 * The only error type domain services throw for expected failures. Adapters map
 * it to the shared ApiError payload without interpreting messages.
 */
export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly objectIds: Record<string, string | null> | undefined;
  readonly current: { revision_id: string; content_hash: string } | undefined;
  readonly duplicates: ApiError['duplicates'];

  constructor(code: ErrorCode, message: string, options: DomainErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'DomainError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.objectIds = options.objectIds;
    this.current = options.current;
    this.duplicates = options.duplicates;
  }

  toApiError(): ApiError {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.objectIds ? { object_ids: this.objectIds } : {}),
      ...(this.current ? { current: this.current } : {}),
      ...(this.duplicates ? { duplicates: this.duplicates } : {}),
    };
  }
}
