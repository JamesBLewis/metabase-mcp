import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['./tests/envSetup.ts'],
    env: {
      NODE_ENV: 'test',
      MAX_RESPONSE_CHARS: '10000000', // 10M chars - disable truncation in tests
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/**',
        'build/**',
        'dist/**',
        '**/*.d.ts',
        '**/*.config.ts',
        'src/index.ts', // Entry point, tested via integration
      ],
      thresholds: {
        global: {
          branches: 80,
          functions: 80,
          lines: 80,
          statements: 80,
        },
      },
    },
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['node_modules/**', 'build/**', 'dist/**'],
  },
  esbuild: {
    target: 'node18',
  },
});
