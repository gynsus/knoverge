import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node24',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
  noExternal: [/^@knoverge\//],
  // `ssh2` stays a real package at runtime rather than being bundled. It is a
  // dependency of `@knoverge/backups`, which is bundled, so esbuild would
  // otherwise follow it — and inside it are optional native bindings
  // (`sshcrypto.node`, `cpufeatures.node`) that this installation deliberately
  // does not build. `ssh2` falls back to its own JavaScript when they are
  // missing, but a bundler resolves them before anything can catch the failure.
  external: ['ssh2'],
});
