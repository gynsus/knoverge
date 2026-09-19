import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Integration tests start a PostgreSQL container.
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
