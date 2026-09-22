// Fails when a component asks for a semantic colour the theme does not define.
//
// Tailwind resolves `bg-popover` through `--color-popover` in the `@theme`
// block. When that variable is absent it emits nothing at all, so the element
// renders transparent rather than wrong — a menu the page reads straight
// through, and no error anywhere to notice. That is the mistake a generated
// shadcn component brings with it, because it is written against a fuller
// palette than this one.
//
// Only the shadcn palette is checked. Tailwind's own scales (`text-emerald-700`)
// and its non-colour utilities (`border-b`, `outline-offset-2`) need no token,
// and treating every dash-separated word as a colour reports those as failures.
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = fileURLToPath(new URL('../src', import.meta.url));
const cssFile = join(srcDir, 'index.css');

/** The roots of the shadcn palette. A `-foreground` or similar tail is allowed. */
const SEMANTIC = [
  'background',
  'foreground',
  'card',
  'popover',
  'primary',
  'secondary',
  'muted',
  'accent',
  'destructive',
  'border',
  'input',
  'ring',
  'sidebar',
  'chart',
];

/** Utilities that take a colour. */
const PREFIXES = ['bg', 'text', 'border', 'ring', 'fill', 'stroke', 'outline', 'decoration'];

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path);
    return ['.ts', '.tsx'].includes(extname(entry.name)) ? [path] : [];
  });
}

const css = readFileSync(cssFile, 'utf8');
const defined = new Set([...css.matchAll(/--color-([a-z0-9-]+)\s*:/g)].map((m) => m[1]));

// A variant chain and an opacity suffix may sit either side of the utility, so
// both are allowed and neither is captured.
const utility = new RegExp(
  String.raw`(?<![\w-])(?:[a-z0-9[\]=.-]+:)*(${PREFIXES.join('|')})-` +
    String.raw`((?:${SEMANTIC.join('|')})(?:-[a-z]+)*)(?![\w-])`,
  'g',
);

let problems = 0;
for (const file of files(srcDir)) {
  for (const [, prefix, name] of readFileSync(file, 'utf8').matchAll(utility)) {
    if (defined.has(name)) continue;
    console.error(`${file.slice(srcDir.length + 1)}: ${prefix}-${name} has no --color-${name}`);
    problems += 1;
  }
}

if (problems > 0) {
  console.error(`check-theme-tokens: ${problems} problem(s)`);
  process.exit(1);
}
console.log(`check-theme-tokens: ${defined.size} tokens, every semantic colour resolves`);
