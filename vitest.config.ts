import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    exclude: ['dist/**', 'node_modules/**'],
    globalSetup: ['tests/cold/global-setup.ts'],
    hookTimeout: 60_000,
    testTimeout: 60_000,
    coverage: { reporter: ['text', 'html'] }
  }
});
