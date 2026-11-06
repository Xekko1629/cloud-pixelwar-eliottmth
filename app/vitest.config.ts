import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    reporters: ['default', 'junit'],
    outputFile: { junit: 'test-results/unit.xml' },
    projects: [
      {
        test: {
          name: 'backend',
          environment: 'node',
          include: [
            'shared/**/*.test.ts',
            'functions/**/*.test.ts',
            'testing/**/*.test.ts',
          ],
          exclude: ['**/*.integration.test.ts', '**/node_modules/**'],
        },
      },
      {
        test: {
          name: 'frontend',
          environment: 'jsdom',
          include: ['frontend/**/*.test.ts'],
          exclude: ['**/*.integration.test.ts', '**/node_modules/**'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      reporter: ['text', 'json-summary', 'lcov', 'html'],
      include: [
        'functions/*/src/**/*.ts',
        'shared/src/**/*.ts',
        'frontend/src/**/*.ts',
        'testing/emulator-environment.ts',
      ],
      exclude: ['**/*.test.ts', '**/*.d.ts'],
      thresholds: {
        perFile: true,
        lines: 70,
        statements: 70,
        functions: 70,
        branches: 70,
      },
    },
  },
});
