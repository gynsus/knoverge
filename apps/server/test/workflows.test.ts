import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The workflows that build this product.
 *
 * Here beside the other guards that read the repository root, for the reason
 * `docs.test.ts` is here: this is the test project that can see the whole
 * repository, and a second one that could would be a second place to look.
 */
const workflows = new URL('../../../.github/workflows/', import.meta.url);

describe('the runner every job asks for', () => {
  it('names a release and not a label that moves', () => {
    // `ubuntu-latest` changes the operating system under the build on a date
    // GitHub picks. For the checks that means a morning where something fails
    // and nothing in the repository changed; for the release workflow it means
    // the multi-arch image of a tag built on an OS nobody chose. Both are
    // raised deliberately, which is what pinning buys.
    const floating: string[] = [];
    for (const name of readdirSync(workflows).filter((file) => file.endsWith('.yml'))) {
      const text = readFileSync(new URL(name, workflows), 'utf8');
      for (const [, label] of text.matchAll(/^\s*runs-on:\s*(?<label>\S+)$/gmu)) {
        if ((label as string).endsWith('-latest')) floating.push(`${name}: ${label as string}`);
      }
    }

    expect(floating).toEqual([]);
  });
});
