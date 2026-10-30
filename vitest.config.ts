import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { include: ['worker/**/*.test.ts', 'tests/**/*.test.ts'], exclude: ['tests/e2e/**'], testTimeout: 20000, hookTimeout: 30000 },
});
