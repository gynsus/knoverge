import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const folder = fileURLToPath(new URL('../migrations', import.meta.url));

/**
 * Drizzle's migrator runs what the journal lists, not what the folder holds.
 *
 * A hand-written migration added to the folder and forgotten in the journal
 * is skipped in silence, and the first sign of it is a table that does not
 * exist, somewhere far from the cause. This is cheap insurance against an
 * afternoon of that.
 */
describe('the migration journal', () => {
  it('lists every migration in the folder, in order', () => {
    const files = readdirSync(folder)
      .filter((name) => name.endsWith('.sql'))
      .map((name) => name.replace(/\.sql$/, ''))
      .sort();
    const journal = JSON.parse(readFileSync(`${folder}/meta/_journal.json`, 'utf8')) as {
      entries: { idx: number; tag: string }[];
    };
    expect(journal.entries.map((e) => e.tag)).toEqual(files);
    // The index is the running order, so a gap or a repeat would run them
    // in an order the schema does not survive.
    expect(journal.entries.map((e) => e.idx)).toEqual(files.map((_, i) => i));
  });
});
