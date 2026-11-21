import { defineConfig, type Plugin } from 'vite';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// Tiny dev-only endpoint so the page can save a canvas screenshot / results into render/.
function saveEndpoint(): Plugin {
  return {
    name: 'render-spike-save',
    configureServer(server) {
      server.middlewares.use('/__save', (req, res) => {
        const url = new URL(req.url ?? '', 'http://x');
        const name = basename(url.searchParams.get('name') ?? 'out.bin');
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          let body = Buffer.concat(chunks);
          const text = body.toString('utf8');
          if (text.startsWith('data:image/png;base64,')) body = Buffer.from(text.slice(22), 'base64');
          writeFileSync(join(here, name), body);
          res.end('ok ' + name + ' ' + body.length);
        });
      });
    },
  };
}

export default defineConfig({
  root: here,
  server: { port: 5181, strictPort: true },
  plugins: [saveEndpoint()],
});
