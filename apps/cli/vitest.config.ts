import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The backup test starts a PostgreSQL container and takes a real dump.
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
