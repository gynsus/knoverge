import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    /**
     * A backstop, not a budget.
     *
     * Every test here drives a real repository, and each operation is a `git`
     * process. Vitest's default of five seconds is enough for a handful of
     * them on an idle machine and not enough when the other eight packages
     * are running too — which is how these passed alone and failed in the
     * suite. Thirty seconds still fails fast on a `git` that has hung.
     */
    testTimeout: 30_000,
  },
});
