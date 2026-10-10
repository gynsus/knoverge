// Fails when any locale is missing keys present in the English source, has keys
// English lacks, or when the source asks for a string the catalogue has not got.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const localesDir = fileURLToPath(new URL('../src/locales', import.meta.url));
const srcDir = fileURLToPath(new URL('../src', import.meta.url));
const source = 'en';

function flatten(obj, prefix = '') {
  return Object.entries(obj).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return value && typeof value === 'object' ? flatten(value, path) : [path];
  });
}

function load(locale, namespace) {
  return JSON.parse(readFileSync(join(localesDir, locale, namespace), 'utf8'));
}

const locales = readdirSync(localesDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);
const namespaces = readdirSync(join(localesDir, source)).filter((f) => f.endsWith('.json'));

/**
 * i18next appends a plural category to a key: greeting_one, greeting_few and so
 * on. Languages have different categories, so English `_one` and `_other` will
 * never line up with Russian `_one`, `_few` and `_many`. Comparing raw keys
 * would report every correct Russian plural as an extra key.
 *
 * So keys are compared with the suffix stripped, and each locale's set of
 * suffixes for a key is checked against what Intl says that language needs.
 */
function splitPlural(key) {
  const match = /^(.*)_(zero|one|two|few|many|other)$/.exec(key);
  return match ? { base: match[1], category: match[2] } : { base: key, category: null };
}

function categorise(keys) {
  const bases = new Set();
  const categories = new Map();
  for (const key of keys) {
    const { base, category } = splitPlural(key);
    bases.add(base);
    if (category) {
      if (!categories.has(base)) categories.set(base, new Set());
      categories.get(base).add(category);
    }
  }
  return { bases, categories };
}

function requiredCategories(locale) {
  return new Set(new Intl.PluralRules(locale).resolvedOptions().pluralCategories);
}

let problems = 0;
for (const namespace of namespaces) {
  const sourceSet = categorise(flatten(load(source, namespace)));
  for (const locale of locales) {
    if (locale === source) continue;
    let target;
    try {
      target = categorise(flatten(load(locale, namespace)));
    } catch {
      console.error(`${locale}/${namespace}: missing file`);
      problems += 1;
      continue;
    }
    for (const base of sourceSet.bases) {
      if (!target.bases.has(base)) {
        console.error(`${locale}/${namespace}: missing key "${base}"`);
        problems += 1;
      }
    }
    for (const base of target.bases) {
      if (!sourceSet.bases.has(base)) {
        console.error(`${locale}/${namespace}: extra key "${base}" not present in ${source}`);
        problems += 1;
      }
    }
    // A pluralised key must carry every category the language has, and no other.
    const needed = requiredCategories(locale);
    for (const [base, categories] of target.categories) {
      for (const category of categories) {
        if (!needed.has(category)) {
          console.error(
            `${locale}/${namespace}: "${base}_${category}" is not a plural category of ${locale}`,
          );
          problems += 1;
        }
      }
      for (const category of needed) {
        if (!categories.has(category)) {
          console.error(`${locale}/${namespace}: "${base}" is missing the ${category} plural`);
          problems += 1;
        }
      }
    }
    // A key pluralised in the source must be pluralised in every locale.
    for (const base of sourceSet.categories.keys()) {
      if (target.bases.has(base) && !target.categories.has(base)) {
        console.error(`${locale}/${namespace}: "${base}" must be pluralised in ${locale}`);
        problems += 1;
      }
    }
  }
}

/**
 * Every literal key the interface asks for, against the catalogue it asks of.
 *
 * The comparison above checks the locales against each other, so a key missing
 * from both passes it. i18next then renders the key itself, and a button reads
 * `common.save` — which is what shipped until a test happened to assert the
 * label. This is the check that would have said so.
 *
 * Only literal keys. A computed one — `t(`webhooks.standings.${standing}`)` —
 * cannot be resolved without running the thing, and the tests that exercise
 * those paths are what cover them.
 */
const CATEGORIES = ['zero', 'one', 'two', 'few', 'many', 'other'];

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function nodeAt(catalogue, key) {
  let node = catalogue;
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null || !(part in node)) return undefined;
    node = node[part];
  }
  return node;
}

function resolves(catalogue, key) {
  if (typeof nodeAt(catalogue, key) === 'string') return true;
  // A pluralised key is stored as `base_one`, `base_other` and so on, and is
  // asked for by its base.
  const cut = key.lastIndexOf('.');
  const holder = cut === -1 ? catalogue : nodeAt(catalogue, key.slice(0, cut));
  const base = key.slice(cut + 1);
  if (typeof holder !== 'object' || holder === null) return false;
  return CATEGORIES.some((category) => typeof holder[`${base}_${category}`] === 'string');
}

if (statSync(srcDir, { throwIfNoEntry: false })) {
  // One namespace, so every key belongs to it. A second one would have to be
  // matched by prefix instead.
  const catalogue = load(source, namespaces[0]);
  const asked = /\bt\(\s*'([A-Za-z0-9_.]+)'/g;
  for (const file of files(srcDir)) {
    const text = readFileSync(file, 'utf8');
    for (const [, key] of text.matchAll(asked)) {
      if (!resolves(catalogue, key)) {
        console.error(
          `${file.slice(srcDir.length + 1)}: asks for "${key}", which ${source} has not`,
        );
        problems += 1;
      }
    }
  }
}

if (problems > 0) {
  console.error(`check-locales: ${problems} problem(s)`);
  process.exit(1);
}
console.log(
  `check-locales: ${locales.length} locales, ${namespaces.length} namespace(s), all keys match`,
);
