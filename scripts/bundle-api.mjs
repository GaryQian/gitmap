// Bundle the AI server (src/ai/server) into api/_lib/server.mjs, the one file the api/ai/* functions
// import. Vercel transpiles each api/**/*.ts file separately without rewriting import paths, and the
// deployed functions run as Node ES modules, where a relative import must name its file exactly; a
// single bundled file with bare package imports is the shape that survives that. Runs before `build`;
// the output is gitignored.
import { build } from 'esbuild';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
await build({
  entryPoints: [path.join(root, 'src/ai/server/index.ts')],
  outfile: path.join(root, 'api/_lib/server.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  packages: 'external',
});
console.log('bundled src/ai/server -> api/_lib/server.mjs');
