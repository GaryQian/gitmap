// Render benchmark (IMPLEMENTATION.md 6E): frame times of the map at several sizes, idle and while
// the camera is dragged. It drives the /dev harness (a synthetic model through the real session:
// store, physics worker, renderer) in Chromium and prints one row per size. Nothing fails on a
// threshold; the numbers are for comparing machines and changes.
//
// Usage: node scripts/bench/render.mjs [--n 1000,10000,100000] [--headed] [--seconds 4] [--url http://localhost:5175]
//
//   --headed   run in a visible browser on this machine's real GPU. Without it the browser is
//              headless and renders on a software GPU, so the absolute numbers mean little: use
//              headless only to compare one change with another on the same machine.
//   To measure integrated graphics, run with --headed on a machine (or with the OS set) to use them.
// Start a dev server first: npx vite --port 5175 --strictPort
import { chromium } from '@playwright/test';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const sizes = opt('n', '1000,10000').split(',').map(Number).filter((n) => n > 0);
const headed = args.includes('--headed');
const seconds = Number(opt('seconds', '4'));
const origin = opt('url', 'http://localhost:5175');

const browser = await chromium.launch(headed
  ? { headless: false, args: ['--ignore-gpu-blocklist'] }
  : { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });

/** Median and 95th-percentile frame interval over `ms`, measured in the page with requestAnimationFrame. */
const sampleFrames = (page, ms) => page.evaluate((duration) => new Promise((resolve) => {
  const gaps = [];
  let last = performance.now();
  const end = last + duration;
  const tick = (t) => {
    gaps.push(t - last);
    last = t;
    if (t < end) requestAnimationFrame(tick);
    else {
      gaps.shift();
      gaps.sort((a, b) => a - b);
      const at = (p) => gaps[Math.min(gaps.length - 1, Math.floor(p * gaps.length))] ?? 0;
      resolve({ frames: gaps.length, median: at(0.5), p95: at(0.95), worst: gaps[gaps.length - 1] ?? 0 });
    }
  };
  requestAnimationFrame(tick);
}), ms);

const rows = [];
try {
  for (const n of sizes) {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    const t0 = Date.now();
    await page.goto(`${origin}/dev.html?n=${n}&seed=1`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__starmap?.state?.ready === true || window.__starmap?.state?.error, null, { timeout: 180000 });
    const state = await page.evaluate(() => window.__starmap.state);
    if (state.error) { rows.push({ files: n, error: state.error }); await page.close(); continue; }
    const readyMs = Date.now() - t0;
    await page.waitForTimeout(2500); // let the reveal finish growing in

    const idle = await sampleFrames(page, seconds * 1000);

    // drag the camera in a slow circle for the same time: the case that has to stay smooth
    const dragging = sampleFrames(page, seconds * 1000);
    const cx = 800, cy = 450;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    const steps = seconds * 30;
    for (let i = 1; i <= steps; i++) {
      const a = (i / steps) * 2 * Math.PI;
      await page.mouse.move(cx + 220 * Math.sin(a), cy + 120 * (1 - Math.cos(a)));
      await page.waitForTimeout(1000 / 30);
    }
    await page.mouse.up();
    const drag = await dragging;

    const stats = await page.evaluate(() => {
      const g = window.__starmap;
      return { ...g.render.stats(), edges: g.session.replica.table('edge').count, cities: g.session.replica.table('city').count };
    });
    const gpu = await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      const info = gl?.getExtension('WEBGL_debug_renderer_info');
      return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'unknown';
    });
    rows.push({
      files: n, edges: stats.edges, cities: stats.cities, 'ready s': +(readyMs / 1000).toFixed(1),
      'idle ms': +idle.median.toFixed(1), 'drag ms': +drag.median.toFixed(1), 'drag p95': +drag.p95.toFixed(1), 'drag worst': +drag.worst.toFixed(0),
      'edges drawn': stats.edgesDrawn, quality: stats.quality, resyncs: stats.resyncs, errors: errors.length, gpu,
    });
    await page.close();
  }
} finally {
  await browser.close();
}

console.log(`render benchmark · ${headed ? 'headed (real GPU)' : 'headless (software GPU: compare runs, not absolutes)'} · ${seconds} s per sample · frame intervals in ms`);
console.table(rows);
