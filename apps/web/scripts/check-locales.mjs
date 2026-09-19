// Fails when any locale is missing keys present in the English source, or has keys English lacks.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const localesDir = fileURLToPath(new URL('../src/locales', import.meta.url));
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

let problems = 0;
for (const namespace of namespaces) {
  const sourceKeys = new Set(flatten(load(source, namespace)));
  for (const locale of locales) {
    if (locale === source) continue;
    let keys;
    try {
      keys = new Set(flatten(load(locale, namespace)));
    } catch {
      console.error(`${locale}/${namespace}: missing file`);
      problems += 1;
      continue;
    }
    for (const key of sourceKeys) {
      if (!keys.has(key)) {
        console.error(`${locale}/${namespace}: missing key "${key}"`);
        problems += 1;
      }
    }
    for (const key of keys) {
      if (!sourceKeys.has(key)) {
        console.error(`${locale}/${namespace}: extra key "${key}" not present in ${source}`);
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
