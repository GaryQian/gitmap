// Runs a TypeScript script through Vite's module runner, so scripts see the same module graph as the
// app and tests (import.meta.glob for plug-in and task discovery, JSON imports, path resolution).
// Usage: node scripts/run.mjs scripts/<name>.ts [args…]
import { createServer, createServerModuleRunner } from 'vite';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [script, ...args] = process.argv.slice(2);
if (!script) {
  console.error('usage: node scripts/run.mjs <script.ts> [args…]');
  process.exit(2);
}
process.argv = [process.argv[0], path.resolve(script), ...args];

const server = await createServer({
  configFile: false,
  root: path.resolve(import.meta.dirname, '..'),
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true, include: [] },
  logLevel: 'error',
});
const runner = createServerModuleRunner(server.environments.ssr, { hmr: false });
let code = 0;
try {
  const mod = await runner.import(pathToFileURL(path.resolve(script)).href);
  if (typeof mod.default === 'function') await mod.default(args);
} catch (err) {
  console.error(err);
  code = 1;
} finally {
  await runner.close();
  await server.close();
}
process.exit(code);
