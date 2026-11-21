// Take a screenshot of a page in headless Chromium, so visual work can be checked from the terminal.
// Usage: node scripts/shot.mjs <url> <out.png> [--wait 1500] [--size 1280x800] [--eval "js expression"] [--click x,y] [--scheme dark|light]
// Prints the --eval result (as JSON) and any console errors. Start a dev server first, on your own
// port: npx vite --port <port> --strictPort
import { chromium } from '@playwright/test';

const [url, out, ...rest] = process.argv.slice(2);
if (!url || !out) {
  console.error('usage: node scripts/shot.mjs <url> <out.png> [--wait ms] [--size WxH] [--eval js] [--click x,y] [--scheme dark|light]');
  process.exit(2);
}
const opt = (name, def) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : def; };
const [width, height] = opt('size', '1280x800').split('x').map(Number);

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width, height }, colorScheme: opt('scheme', 'dark') });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
try {
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(Number(opt('wait', '1500')));
  const click = opt('click');
  if (click) {
    const [x, y] = click.split(',').map(Number);
    await page.mouse.click(x, y);
    await page.waitForTimeout(500);
  }
  const expr = opt('eval');
  if (expr) console.log('eval:', JSON.stringify(await page.evaluate(expr)));
  await page.screenshot({ path: out });
  console.log('saved', out);
} finally {
  if (errors.length) console.log('console errors:\n' + errors.slice(0, 20).join('\n'));
  await browser.close();
}
