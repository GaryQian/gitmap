import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Cross-origin isolation is required for SharedArrayBuffer (PLAN.md §3).
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: false, headers: isolation },
  preview: { headers: isolation },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        dev: resolve(import.meta.dirname, 'dev.html'),
      },
    },
  },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/**/*.test.ts', 'api/**/*.test.ts', 'fixtures/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'spikes/**', '.worktrees/**', '.claude/**', 'dist/**'],
    environment: 'node',
    testTimeout: 30000,
    pool: 'forks',
  },
});
