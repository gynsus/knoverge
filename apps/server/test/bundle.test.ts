import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import cli from '../../cli/tsup.config.ts';
import server from '../tsup.config.ts';

/**
 * What a bundle leaves out, the deployed package has to ask for.
 *
 * `pnpm deploy --prod` installs what the app's own `package.json` names. A
 * dependency of a workspace package arrives only inside pnpm's private
 * directory, which is not on the resolution path of the bundle beside it — so a
 * name that is external but undeclared bundles cleanly, builds an image
 * cleanly, and fails on the first import when the process starts. `ssh2` did
 * exactly that, and no check in this repository would have noticed.
 */
function declared(manifest: string): string[] {
  const parsed = JSON.parse(readFileSync(new URL(manifest, import.meta.url), 'utf8')) as {
    dependencies: Record<string, string>;
  };
  return Object.keys(parsed.dependencies);
}

/**
 * The external names of one config.
 *
 * `defineConfig` is typed as any of the shapes it accepts, so the one object
 * both of ours are has to be established rather than assumed — and if either
 * ever becomes a list or a function, this says so instead of reading nothing
 * and passing.
 */
function names(config: typeof server | typeof cli): string[] {
  if (typeof config === 'function' || Array.isArray(config)) {
    throw new Error('this test reads one configuration object, and was given another shape');
  }
  return (config.external ?? []).filter((entry): entry is string => typeof entry === 'string');
}

describe('what the bundles keep out of themselves', () => {
  it('is a dependency the server deploys with', () => {
    const missing = names(server).filter((name) => !declared('../package.json').includes(name));

    expect(missing).toEqual([]);
  });

  it('is a dependency the command line deploys with', () => {
    const missing = names(cli).filter((name) => !declared('../../cli/package.json').includes(name));

    expect(missing).toEqual([]);
  });
});
