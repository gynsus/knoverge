import { readdirSync, readFileSync } from 'node:fs';
import { TOOLS } from '@knoverge/contracts';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

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

  it('says how many tools there are, and says the number there are', () => {
    // It said twenty-six for three tools longer than it was true. A number
    // written in prose is a claim, and a claim about the contract can be
    // checked against the contract.
    const readme = readFileSync(new URL('README.md', root), 'utf8');
    const words = [
      'twenty-five',
      'twenty-six',
      'twenty-seven',
      'twenty-eight',
      'twenty-nine',
      'thirty',
      'thirty-one',
      'thirty-two',
    ];
    const said = words.filter((word) => readme.includes(`${word} tools`));
    expect(said).toEqual([words[TOOLS.length - 25]]);
  });
});

/**
 * The instructions somebody follows before they have an installation.
 *
 * These are the only documents a reader cannot check against the product,
 * because they are what they read instead of having one. A wrong line here is
 * not a stale sentence: it is a command that fails on a machine where nothing
 * is running yet, and the reader has no way to tell whether they or the
 * document is wrong.
 */
describe('the instructions for a first run', () => {
  const compose = parse(readFileSync(new URL('docker-compose.yml', root), 'utf8')) as {
    volumes: Record<string, { external?: boolean; name?: string } | null>;
  };

  /** `${KNOVERGE_DATA_VOLUME:-knoverge-data}` is called `knoverge-data`. */
  function defaultName(entry: { name?: string }, key: string): string {
    const written = entry.name ?? key;
    return /^\$\{[^:]+:-(?<fallback>[^}]+)\}$/u.exec(written)?.groups?.['fallback'] ?? written;
  }

  const external = Object.entries(compose.volumes)
    .filter(([, entry]) => entry?.external === true)
    .map(([key, entry]) => defaultName(entry ?? {}, key));

  it.each([['README.md'], ['docs/DEPLOYMENT.md']])(
    'says to create every volume the compose file will not create, in %s',
    (document) => {
      // A volume declared external is one Compose refuses to invent: the run
      // stops with `external volume "..." not found` before anything starts.
      // The backups volume was added to the compose file and to neither of
      // these, and every fresh installation after that failed at the last step.
      const text = readFileSync(new URL(document, root), 'utf8');
      const missing = external.filter((name) => !text.includes(`docker volume create ${name}`));

      expect(missing).toEqual([]);
    },
  );

  it('offers the image of the newest release and not an older one', () => {
    // An operator who would rather not build from source copies this line. It
    // said 0.3.0 in four places while 0.6.0 was out, which is three releases of
    // fixes they would not have had and no way for them to know.
    const changelog = readFileSync(new URL('CHANGELOG.md', root), 'utf8');
    const newest = /^## v(?<version>\d+\.\d+\.\d+)/mu.exec(changelog)?.groups?.['version'];
    expect(newest).toBeDefined();

    const pinned = new Set<string>();
    for (const document of ['README.md', 'docs/DEPLOYMENT.md']) {
      const text = readFileSync(new URL(document, root), 'utf8');
      for (const [, version] of text.matchAll(/ghcr\.io\/gynsus\/knoverge:(\d+\.\d+\.\d+)/gu)) {
        pinned.add(version as string);
      }
    }

    expect([...pinned].sort()).toEqual([newest]);
  });
});
