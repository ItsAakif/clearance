import { defineConfig } from 'vitest/config';
import path from 'path';

// ADR-031 decision 3: node environment only. No jsdom, no React Testing
// Library, no `.test.tsx` support - frontend tests cover pure modules only
// (see .planning/specs/wave-0-blockers-and-gates.md section D).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
