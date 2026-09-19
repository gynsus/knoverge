import { DomainError } from '@knoverge/core';

const UNIQUE_VIOLATION = '23505';

interface PgError {
  code?: string;
  constraint?: string;
}

function driverError(err: unknown): PgError | null {
  if (err && typeof err === 'object') {
    const cause = (err as { cause?: unknown }).cause;
    if (cause && typeof cause === 'object' && 'code' in cause) return cause as PgError;
    if ('code' in err) return err as PgError;
  }
  return null;
}

/**
 * Maps a PostgreSQL unique violation to a DomainError so races on unique
 * columns surface as validation errors, not as internal failures.
 */
export function rethrowUniqueViolation(
  err: unknown,
  message: string,
  objectIds?: Record<string, string | null>,
): never {
  const pg = driverError(err);
  if (pg?.code === UNIQUE_VIOLATION) {
    throw new DomainError('VALIDATION_ERROR', message, {
      cause: err,
      ...(objectIds ? { objectIds } : {}),
    });
  }
  throw err;
}
