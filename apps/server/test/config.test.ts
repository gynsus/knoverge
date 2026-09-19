import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from '../src/config.ts';

const base = { KNOVERGE_DATABASE_URL: 'postgres://u:p@localhost:5432/db' };

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig(base);
    expect(c.port).toBe(3000);
    expect(c.host).toBe('127.0.0.1');
    expect(c.role).toBe('all');
    expect(c.dataDir).toMatch(/[\\/]data$/);
    expect(c.dataDir).not.toMatch(/^\./);
    expect(c.logLevel).toBe('info');
    expect(c.trustProxy).toBe(false);
    expect(c.autoMigrate).toBe(true);
    expect(c.webDist).toBeUndefined();
  });

  it('parses auto-migrate and web dist', () => {
    const c = loadConfig({ ...base, KNOVERGE_AUTO_MIGRATE: 'false', KNOVERGE_WEB_DIST: 'web' });
    expect(c.autoMigrate).toBe(false);
    expect(c.webDist).toMatch(/[\\/]web$/);
  });

  it('parses overrides', () => {
    const c = loadConfig({
      ...base,
      KNOVERGE_PORT: '4010',
      KNOVERGE_ROLE: 'worker',
      KNOVERGE_TRUST_PROXY: 'true',
      KNOVERGE_LOG_LEVEL: 'debug',
    });
    expect(c.port).toBe(4010);
    expect(c.role).toBe('worker');
    expect(c.trustProxy).toBe(true);
    expect(c.logLevel).toBe('debug');
  });

  it('fails without a database url', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/KNOVERGE_DATABASE_URL/);
  });

  it('rejects a non-postgres database url', () => {
    expect(() => loadConfig({ KNOVERGE_DATABASE_URL: 'mysql://x' })).toThrow(/postgres/);
  });

  it('rejects an invalid role', () => {
    expect(() => loadConfig({ ...base, KNOVERGE_ROLE: 'admin' })).toThrow(ConfigError);
  });
});
