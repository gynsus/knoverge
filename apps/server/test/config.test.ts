import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from '../src/config.ts';

const base = {
  KNOVERGE_DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  KNOVERGE_LEDGER_KEY: 'ab'.repeat(32),
  KNOVERGE_SESSION_SECRET: 'cd'.repeat(32),
  KNOVERGE_TOKEN_PEPPER: 'ef'.repeat(32),
};

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
    expect(() => loadConfig({ KNOVERGE_LEDGER_KEY: base.KNOVERGE_LEDGER_KEY })).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ KNOVERGE_LEDGER_KEY: base.KNOVERGE_LEDGER_KEY })).toThrow(
      /KNOVERGE_DATABASE_URL/,
    );
  });

  it('requires a well-formed ledger key', () => {
    expect(() => loadConfig({ KNOVERGE_DATABASE_URL: base.KNOVERGE_DATABASE_URL })).toThrow(
      /KNOVERGE_LEDGER_KEY/,
    );
    expect(() => loadConfig({ ...base, KNOVERGE_LEDGER_KEY: 'zz' })).toThrow(/hex/);
    expect(() => loadConfig({ ...base, KNOVERGE_LEDGER_KEY: 'ab'.repeat(8) })).toThrow(/32 bytes/);
    expect(loadConfig(base).ledgerKeys.signing.bytes).toHaveLength(32);
  });

  it('takes the version a release baked in, and nothing when there is none', () => {
    // package.json says 0.0.0 and always will, so an image that reported the
    // source tree's number would report it for every release ever cut.
    expect(loadConfig({ ...base, KNOVERGE_VERSION: '0.1.0' }).version).toBe('0.1.0');
    expect(loadConfig(base).version).toBeUndefined();
  });

  it('keeps a retired ledger key for verification, and refuses a malformed one', () => {
    // A key is retired rather than replaced: the events it signed are still there
    // and still verify, because rehashing them is what rotation must not mean
    // here (ADR 0030).
    const rotated = loadConfig({
      ...base,
      KNOVERGE_LEDGER_KEY_RETIRED: `${'cd'.repeat(32)}, ${'ef'.repeat(32)}`,
    });
    expect(rotated.ledgerKeys.retired).toHaveLength(2);
    expect(rotated.ledgerKeys.retired[0]?.bytes).toHaveLength(32);
    // Nothing configured is one key and no rotation, not an empty entry.
    expect(loadConfig({ ...base, KNOVERGE_LEDGER_KEY_RETIRED: '' }).ledgerKeys.retired).toEqual([]);
    expect(() => loadConfig({ ...base, KNOVERGE_LEDGER_KEY_RETIRED: 'zz' })).toThrow(/hex/);
  });

  it('requires a session secret and derives cookie security from the base url', () => {
    const { KNOVERGE_SESSION_SECRET: _s, ...withoutSecret } = base;
    expect(() => loadConfig(withoutSecret)).toThrow(/KNOVERGE_SESSION_SECRET/);
    const { KNOVERGE_TOKEN_PEPPER: _p, ...withoutPepper } = base;
    expect(() => loadConfig(withoutPepper)).toThrow(/KNOVERGE_TOKEN_PEPPER/);
    expect(loadConfig(base).cookieSecure).toBe(false);
    expect(loadConfig({ ...base, KNOVERGE_BASE_URL: 'https://kn.example.com' }).cookieSecure).toBe(
      true,
    );
  });

  it('rejects a non-postgres database url', () => {
    expect(() => loadConfig({ ...base, KNOVERGE_DATABASE_URL: 'mysql://x' })).toThrow(/postgres/);
  });

  it('rejects an invalid role', () => {
    expect(() => loadConfig({ ...base, KNOVERGE_ROLE: 'admin' })).toThrow(ConfigError);
  });
});
