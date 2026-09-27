import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { HealthCheck } from '@knoverge/contracts';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.ts';

const ok: HealthCheck = { status: 'ok' };
const probes = { database: async () => ok, dataDir: async () => ok };

let webDist: string;
beforeAll(async () => {
  webDist = await mkdtemp(join(tmpdir(), 'knoverge-web-'));
  // A real shell, because the server injects the style nonce before `</head>`
  // and refuses to start without one.
  await writeFile(
    join(webDist, 'index.html'),
    '<!doctype html><html><head><title>Knoverge</title></head><body><div id="root">spa</div></body></html>',
  );
  await writeFile(join(webDist, 'app.js'), 'console.log(1)');
  await mkdir(join(webDist, 'assets'), { recursive: true });
  await writeFile(join(webDist, 'assets', 'index-abc123.js'), 'export {}');
});

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

async function app(dist?: string) {
  const instance = await buildApp({ version: '0', probes, ...(dist ? { webDist: dist } : {}) });
  apps.push(instance);
  return instance;
}

describe('static web bundle', () => {
  it('serves index.html at /', async () => {
    const res = await (await app(webDist)).inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('id="root"');
  });

  it('serves asset files', async () => {
    const res = await (await app(webDist)).inject({ method: 'GET', url: '/app.js' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('console.log(1)');
  });

  it('falls back to index.html for client-side routes', async () => {
    const res = await (await app(webDist)).inject({ method: 'GET', url: '/review/inbox' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('id="root"');
  });

  it('never stores index.html but marks hashed assets immutable', async () => {
    // `no-store`, not `no-cache`: the shell carries a per-response style nonce,
    // and a stored body revalidated with a 304 would hand yesterday's nonce to a
    // page served under today's policy.
    const instance = await app(webDist);
    const index = await instance.inject({ method: 'GET', url: '/' });
    expect(index.headers['cache-control']).toBe('no-store');
    const fallback = await instance.inject({ method: 'GET', url: '/some/route' });
    expect(fallback.headers['cache-control']).toBe('no-store');
    const asset = await instance.inject({ method: 'GET', url: '/assets/index-abc123.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toContain('immutable');
  });

  it('does not fall back for API-shaped paths', async () => {
    for (const url of ['/v1/nothing', '/health/nothing', '/mcp']) {
      const res = await (await app(webDist)).inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
      expect(res.json().code).toBe('NOT_FOUND');
    }
  });

  it('does not fall back for non-GET requests', async () => {
    const res = await (await app(webDist)).inject({ method: 'POST', url: '/anything' });
    expect(res.statusCode).toBe(404);
  });

  it('returns plain 404 when no bundle is configured', async () => {
    const res = await (await app()).inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(404);
  });

  it('refuses to start on a bundle with nowhere to put the nonce', async () => {
    // Without a `</head>` the nonce never reaches the interface, every dialog is
    // blocked by our own policy, and a running server says nothing about it.
    const broken = await mkdtemp(join(tmpdir(), 'knoverge-web-broken-'));
    await writeFile(join(broken, 'index.html'), '<div id="root">no head here</div>');
    const failed = await app(broken).then(
      () => null,
      (error: unknown) => error as Error,
    );
    expect(failed?.message).toMatch(/no <\/head>/);
  });
});
