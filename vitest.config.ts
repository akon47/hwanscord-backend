import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    globals: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    setupFiles: ['test/setup.ts'],
  },
});
