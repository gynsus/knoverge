import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const apiTarget = process.env['KNOVERGE_DEV_API'] ?? 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // The '@' alias shadcn/ui generates its components against.
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    proxy: {
      '/health': apiTarget,
      '/v1': apiTarget,
      '/mcp': apiTarget,
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
    /**
     * The outer backstop, not the budget a wait is measured against.
     *
     * Vitest's default is five seconds, which is exactly what `setup.ts` gives
     * a single `findBy*`. A test that waits twice therefore could not spend
     * its own budget, and under load — every package's tests at once, with
     * containers starting — the run died on "Test timed out" instead of on the
     * assertion that was actually unmet. Well above it, a broken page still
     * fails at five seconds with a message naming what was missing.
     */
    testTimeout: 20_000,
  },
});
