import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The documentation map is the only index of this documentation.
 *
 * There used to be a second one, `SPEC_INDEX.md`, and it went stale the way a
 * second list of anything does: it still named ten ADRs when there were thirty-one.
 * With one list left, what keeps it honest is this.
 */
const root = new URL('../../../', import.meta.url);

describe('the documentation map in the README', () => {
  it('names every document under docs/', () => {
    const readme = readFileSync(new URL('README.md', root), 'utf8');
    const docs = readdirSync(new URL('docs/', root))
      .filter((name) => name.endsWith('.md'))
      .sort();
    // A document nobody links to is one a reader finds by listing a directory,
    // which is not a thing a reader of a repository does.
    const missing = docs.filter((name) => !readme.includes(`docs/${name}`));
    expect(missing).toEqual([]);
  });
});
