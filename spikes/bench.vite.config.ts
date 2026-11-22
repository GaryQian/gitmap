// Static multi-page build of the M0 benchmark pages, for a Vercel preview.
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
const here = fileURLToPath(new URL('.', import.meta.url));
const iso = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };
export default defineConfig({
  root: here,
  base: './',
  cacheDir: here + '.vite-bench-cache',
  worker: { format: 'es' },
  preview: { port: 5184, strictPort: true, headers: iso },
  build: {
    outDir: here + 'bench-dist', emptyOutDir: true, target: 'es2022',
    rollupOptions: { input: {
      index: here + 'bench/index.html', gpu: here + 'bench/gpu.html', render: here + 'render/index.html',
      physics: here + 'physics/index.html', fsa: here + 'fsa/index.html', walk: here + 'git/browser/walk.html',
    } },
  },
});
