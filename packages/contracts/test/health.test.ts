import { describe, expect, it } from 'vitest';

import { ApiError, ErrorCode, ReadyResponse } from '../src/index.ts';

describe('ReadyResponse', () => {
  it('accepts a healthy payload', () => {
    const parsed = ReadyResponse.parse({
      status: 'ok',
      version: '0.0.0',
      checks: {
        database: { status: 'ok', latency_ms: 3 },
        data_dir: { status: 'ok' },
      },
    });
    expect(parsed.status).toBe('ok');
  });

  it('accepts optional migrations and jobs checks', () => {
    const parsed = ReadyResponse.parse({
      status: 'degraded',
      version: '0.0.0',
      checks: {
        database: { status: 'ok' },
        data_dir: { status: 'ok' },
        migrations: { status: 'failed', error: '1 pending' },
        jobs: { status: 'ok', latency_ms: 4 },
      },
    });
    expect(parsed.checks.migrations?.status).toBe('failed');
  });

  it('rejects an unknown check status', () => {
    const result = ReadyResponse.safeParse({
      status: 'ok',
      version: '0.0.0',
      checks: {
        database: { status: 'maybe' },
        data_dir: { status: 'ok' },
      },
    });
    expect(result.success).toBe(false);
  });
});

describe('ApiError', () => {
  it('lists the minimum error codes from CLAUDE.md', () => {
    expect(ErrorCode.options).toContain('REVISION_CONFLICT');
    expect(ErrorCode.options).toContain('DUPLICATE_SUSPECTED');
    expect(ErrorCode.options).toHaveLength(13);
  });

  it('requires code, message and retryable', () => {
    expect(ApiError.safeParse({ code: 'NOT_FOUND', message: 'x' }).success).toBe(false);
    expect(ApiError.safeParse({ code: 'NOT_FOUND', message: 'x', retryable: false }).success).toBe(
      true,
    );
  });
});
