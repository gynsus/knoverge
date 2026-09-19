import { LiveResponse, ReadyResponse, type HealthCheck } from '@knoverge/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.ts';
import type { ReadinessProbes } from '../src/probes.ts';

const ok: HealthCheck = { status: 'ok', latency_ms: 1 };
const failed: HealthCheck = { status: 'failed', error: 'connection refused' };

function probes(database: HealthCheck, dataDir: HealthCheck): ReadinessProbes {
  return { database: async () => database, dataDir: async () => dataDir };
}

const apps: ReturnType<typeof buildApp>[] = [];
function app(p: ReadinessProbes) {
  const instance = buildApp({ version: '1.2.3', probes: p });
  apps.push(instance);
  return instance;
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

describe('GET /health/live', () => {
  it('returns ok without touching dependencies', async () => {
    const res = await app(probes(failed, failed)).inject({ method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(200);
    expect(LiveResponse.parse(res.json())).toEqual({ status: 'ok' });
  });
});

describe('GET /health/ready', () => {
  it('returns 200 and ok when every probe passes', async () => {
    const res = await app(probes(ok, ok)).inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    const body = ReadyResponse.parse(res.json());
    expect(body.status).toBe('ok');
    expect(body.version).toBe('1.2.3');
    expect(body.checks.database.status).toBe('ok');
  });

  it('returns 503 and degraded when the database probe fails', async () => {
    const res = await app(probes(failed, ok)).inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(503);
    const body = ReadyResponse.parse(res.json());
    expect(body.status).toBe('degraded');
    expect(body.checks.database.error).toBe('connection refused');
  });

  it('includes optional probes and degrades when one fails', async () => {
    const res = await app({
      ...probes(ok, ok),
      migrations: async () => ({ status: 'failed', error: '1 pending migration(s): 0001_x' }),
      jobs: async () => ok,
    }).inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(503);
    const body = ReadyResponse.parse(res.json());
    expect(body.checks.migrations?.status).toBe('failed');
    expect(body.checks.jobs?.status).toBe('ok');
  });

  it('omits optional probes that are not configured', async () => {
    const res = await app(probes(ok, ok)).inject({ method: 'GET', url: '/health/ready' });
    const body = ReadyResponse.parse(res.json());
    expect(body.checks.migrations).toBeUndefined();
    expect(body.checks.jobs).toBeUndefined();
  });

  it('returns 503 when the data directory probe fails', async () => {
    const res = await app(probes(ok, failed)).inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(503);
  });

  it('uses a client-supplied request id for the request', async () => {
    const instance = app(probes(ok, ok));
    let seen: string | undefined;
    instance.addHook('onRequest', async (request) => {
      seen = request.id;
    });
    await instance.inject({
      method: 'GET',
      url: '/health/live',
      headers: { 'x-request-id': 'req-42' },
    });
    expect(seen).toBe('req-42');
  });

  it('replaces a malformed client request id', async () => {
    const instance = app(probes(ok, ok));
    let seen: string | undefined;
    instance.addHook('onRequest', async (request) => {
      seen = request.id;
    });
    await instance.inject({
      method: 'GET',
      url: '/health/live',
      headers: { 'x-request-id': 'bad id\nwith newline' },
    });
    expect(seen).toMatch(/^[0-9a-f-]{36}$/);
  });
});
