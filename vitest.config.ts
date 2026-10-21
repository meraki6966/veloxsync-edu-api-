import { defineConfig } from 'vitest/config';

// Tests live in tests/, outside src/, so `npx tsc` never compiles them into dist.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
