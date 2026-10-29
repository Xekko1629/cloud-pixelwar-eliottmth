import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['**/*.integration.test.ts'],
    exclude: ['**/node_modules/**'],
    setupFiles: ['testing/integration-setup.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    reporters: ['default', 'junit'],
    outputFile: { junit: 'test-results/integration.xml' },
  },
});
