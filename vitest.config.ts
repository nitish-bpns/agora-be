import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    exclude: ['dist/**', 'node_modules/**'],
    globalSetup: ['tests/cold/global-setup.ts'],
    hookTimeout: 60_000,
    testTimeout: 60_000,
    coverage: { reporter: ['text', 'html'] },
    // Each test file spins up its own in-memory MongoDB replica set.
    // Run files sequentially, each in its own forked process (vitest default
    // isolation), so the process-global `mongoose` singleton is never shared
    // between files — this keeps database lifecycles fully isolated.
    fileParallelism: false
  }
});
