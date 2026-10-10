import { defineConfig } from 'vitest/config';

// Benchmark case repos under bench/ carry their own node:test suites; keep them out of Veritas's own tests.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
