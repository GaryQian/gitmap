import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { loadEnv, type Plugin } from 'vite';
import { holdReloads } from './scripts/holdReloads';

// Cross-origin isolation is required for SharedArrayBuffer (PLAN.md §3).
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

/** The part of src/ai/server the dev routes use; the module is loaded through the dev server, never imported here. */
interface AiServerModule {
  handlers: Record<string, (request: Request, deps: unknown) => Promise<Response>>;
  createDeps(env: Record<string, string | undefined>): unknown;
}

const AI_ROUTE = /^\/api\/ai\/(summaries|pois|tour|detail|chat)\/?(?:\?.*)?$/;

/** A Node request as the Web Request the handlers take. The body is read whole: the handlers cap its size themselves. */
async function toWebRequest(req: IncomingMessage, res: ServerResponse): Promise<Request> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  const method = req.method ?? 'GET';
  let body: Uint8Array<ArrayBuffer> | undefined;
  if (method !== 'GET' && method !== 'HEAD') {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    body = new Uint8Array(Buffer.concat(chunks));
  }
  // The browser going away (a cancelled generation) aborts the request the handler is serving.
  const gone = new AbortController();
  res.on('close', () => { if (!res.writableEnded) gone.abort(); });
  return new Request(new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`), { method, headers, body, signal: gone.signal });
}

/** Write a Web Response to a Node response, chunk by chunk, so a streamed answer arrives as it is produced. */
async function sendWebResponse(response: Response, res: ServerResponse): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => res.setHeader(name, value));
  if (!response.body) { res.end(); return; }
  res.flushHeaders();
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value)) await new Promise<void>((drained) => res.once('drain', drained));
    }
  } finally {
    res.end();
  }
}

/**
 * Dev server only: POST /api/ai/{summaries,pois,tour,detail}, answered by the same handlers the
 * Vercel functions in api/ai/ mount (src/ai/server). The module is loaded through the dev server, so
 * an edit to it takes effect on the next request. The key comes from the environment or a .env file
 * (ANTHROPIC_API_KEY); without one the handlers answer with their own "no key" error.
 */
function aiDevRoutes(): Plugin {
  return {
    name: 'gitmap:ai-dev-routes',
    apply: 'serve',
    configureServer(server) {
      const env = loadEnv(server.config.mode, server.config.envDir || server.config.root, '');
      // One set of dependencies (so one rate limiter) per loaded copy of the module.
      let loaded: AiServerModule | null = null;
      let deps: unknown = null;
      server.middlewares.use((req, res, next) => {
        const route = AI_ROUTE.exec(req.url ?? '')?.[1];
        if (!route) { next(); return; }
        void (async () => {
          try {
            const mod = (await server.ssrLoadModule('/src/ai/server/index.ts')) as AiServerModule;
            if (mod !== loaded) { loaded = mod; deps = mod.createDeps(env); }
            await sendWebResponse(await mod.handlers[route](await toWebRequest(req, res), deps), res);
          } catch (err) {
            server.config.logger.error(`[ai] ${route}: ${String((err as Error)?.stack ?? err)}`);
            if (!res.headersSent) {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: { code: 'provider', message: 'The AI route failed in the dev server; see its log.' } }));
            } else res.end();
          }
        })();
      });
    },
  };
}

export default defineConfig({
  // holdReloads: a tab showing a map is not reloaded under it by code changes (scripts/holdReloads.ts)
  // aiDevRoutes: /api/ai/* in the dev server, from the handlers the deployed functions use
  plugins: [react(), holdReloads(), aiDevRoutes()],
  server: { port: 5173, strictPort: false, headers: isolation },
  preview: { headers: isolation },
  worker: { format: 'es' },
  // Every browser dependency is pre-bundled at start-up, including the ones only workers import.
  // Left to discovery, the dev server finds them one at a time as workers load, re-bundles in the
  // middle of a session, and a tab that is already open then asks for modules that no longer exist:
  // its coordinator and compute workers fail to load with no message at all.
  // The list is explicit on purpose: scanning the worker entry points instead means crawling every
  // task module at each start, which made the first response take most of a minute under load.
  optimizeDeps: {
    include: [
      'react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'zustand', 'three',
      'd3-force', 'd3-delaunay', 'fflate', 'graphology', 'graphology-communities-louvain', 'picomatch',
      '@leeoniya/ufuzzy', 'web-tree-sitter', 'marked', 'dompurify',
      '@codemirror/state', '@codemirror/view', '@codemirror/language', '@codemirror/commands',
      '@codemirror/autocomplete', '@codemirror/search', '@codemirror/language-data', '@lezer/highlight',
    ],
  },
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
