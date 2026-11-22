// Browser benchmark (IMPLEMENTATION.md 6E): the two things the Node benchmarks cannot see.
//
//   render      frame times of the real renderer at several map sizes (synthetic maps through the
//               real session: store, physics worker, renderer), at rest and while the camera moves
//   read paths  the whole folder pipeline in a browser, reading a real repo through the File System
//               Access API (a FileSystemDirectoryHandle, here in the origin private file system) and
//               through a dropped-files list (the Firefox / Safari path), timed per stage
//
// It starts its own dev server and its own Chromium, prints a table, and stops both. Nothing fails
// on a threshold: the numbers are for comparing machines and before / after a change. The graphics
// adapter Chromium actually used is printed with the results, because that decides what the render
// numbers mean; run it on a laptop to measure integrated graphics.
//
// Usage: node scripts/bench/browser.mjs [--sizes 1000,10000,50000,100000] [--repo <folder>]...
//          [--runs n]       runs per read path (default 2)
//          [--headed]       show the browser window (some machines only give a headless browser software rendering)
//          [--no-render] [--no-read]
//          [--json file]    also write the raw numbers as JSON
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = path.resolve(import.meta.dirname, '../..');

function parseArgs(argv) {
  const args = { sizes: [1000, 10000, 50000, 100000], repos: [], runs: 2, headed: false, render: true, read: true, json: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sizes') args.sizes = argv[++i].split(',').map(Number).filter((n) => n > 0);
    else if (a === '--repo') args.repos.push(path.resolve(argv[++i]));
    else if (a === '--runs') args.runs = Math.max(1, Number(argv[++i]) || 1);
    else if (a === '--headed') args.headed = true;
    else if (a === '--no-render') args.render = false;
    else if (a === '--no-read') args.read = false;
    else if (a === '--json') args.json = path.resolve(argv[++i]);
    else throw new Error(`unknown option ${a}`);
  }
  return args;
}

const ms = (n) => (n == null ? '—' : n < 10 ? n.toFixed(1) : Math.round(n).toLocaleString('en-US'));
const pad = (s, w) => String(s).padStart(w);
const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];

// ---- render ----

/** Frame intervals over `seconds`, measured by the page's own animation frames. */
function collectFrames(page, seconds) {
  return page.evaluate((duration) => new Promise((resolve) => {
    const deltas = [];
    let last = performance.now();
    const end = last + duration * 1000;
    const tick = (t) => {
      deltas.push(t - last);
      last = t;
      if (t < end) requestAnimationFrame(tick); else resolve(deltas.slice(1));
    };
    requestAnimationFrame(tick);
  }), seconds);
}

function summarize(deltas) {
  const sorted = [...deltas].sort((a, b) => a - b);
  if (sorted.length === 0) return { frames: 0, median: null, p95: null, worst: null, fps: 0 };
  const total = deltas.reduce((a, b) => a + b, 0);
  return { frames: sorted.length, median: quantile(sorted, 0.5), p95: quantile(sorted, 0.95), worst: sorted[sorted.length - 1], fps: (sorted.length / total) * 1000 };
}

async function benchRender(browser, base, size) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  try {
    const t0 = Date.now();
    await page.goto(`${base}/dev.html?n=${size}&seed=2`);
    await page.waitForFunction(() => window.__starmap?.state?.ready === true || window.__starmap?.state?.error, null, { timeout: 300000 });
    const error = await page.evaluate(() => window.__starmap.state.error);
    if (error) return { size, error };
    const readyMs = Date.now() - t0;
    await page.waitForTimeout(3000); // the reveal animation and the first idle frames
    const rest = summarize(await collectFrames(page, 4));
    // the camera moving: wheel zoom in and out, and a drag (pan), while frames are counted
    const moving = collectFrames(page, 5);
    await page.mouse.move(800, 450);
    for (let i = 0; i < 12; i++) { await page.mouse.wheel(0, i % 2 ? 240 : -240); await page.waitForTimeout(120); }
    await page.mouse.down();
    for (let i = 0; i < 30; i++) { await page.mouse.move(800 + Math.sin(i / 5) * 300, 450 + Math.cos(i / 5) * 160); await page.waitForTimeout(60); }
    await page.mouse.up();
    const move = summarize(await moving);
    const stats = await page.evaluate(() => {
      const s = window.__starmap.render.stats();
      return { spheres: s.spheres, edgesDrawn: s.edgesDrawn, frameMs: s.frameMs, quality: s.quality };
    });
    return { size, readyMs, rest, move, stats };
  } finally {
    await page.close();
  }
}

async function graphics(browser, base) {
  const page = await browser.newPage();
  try {
    await page.goto(`${base}/dev.html?fake=1&n=10`);
    return await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      if (!gl) return { renderer: 'no WebGL2', vendor: '' };
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
        cores: navigator.hardwareConcurrency,
        refresh: null,
      };
    });
  } finally {
    await page.close();
  }
}

// ---- read paths ----

/**
 * A repo as the /dev harness's fixture bundle, out/fixtures/<name>.json: its tracked files and its
 * .git directory (what a parse reads), or every file when the folder is not a git repo.
 */
function bundleRepo(dir, name) {
  const files = {};
  let bytes = 0;
  const add = (rel) => {
    let st;
    try { st = statSync(path.join(dir, rel)); } catch { return; } // tracked, but gone from the working tree
    if (!st.isFile()) return;
    files[rel] = readFileSync(path.join(dir, rel)).toString('base64');
    bytes += st.size;
  };
  const walk = (at, rel) => {
    for (const entry of readdirSync(at).sort()) {
      if (entry.endsWith('.lock') || entry === 'node_modules') continue;
      const next = rel ? `${rel}/${entry}` : entry;
      if (statSync(path.join(at, entry)).isDirectory()) walk(path.join(at, entry), next);
      else add(next);
    }
  };
  const gitDir = path.join(dir, '.git');
  if (existsSync(gitDir) && statSync(gitDir).isDirectory()) {
    const tracked = execFileSync('git', ['-C', dir, 'ls-files', '-z'], { maxBuffer: 1 << 28 }).toString('utf8').split('\u0000').filter(Boolean);
    for (const rel of tracked) add(rel);
    walk(gitDir, '.git');
  } else walk(dir, '');
  const out = path.join(root, 'out/fixtures', `${name}.json`);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ name, files }));
  return { count: Object.keys(files).length, bytes };
}

/** One run of the folder pipeline in the page: when each stage was first seen, from the first stage on. */
async function benchRead(browser, base, name, via) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  try {
    await page.goto(`${base}/dev.html?fixture=${encodeURIComponent(name)}&via=${via}&fresh=1`);
    const seen = new Map();
    let start = null;
    const deadline = Date.now() + 600000;
    for (;;) {
      const s = await page.evaluate(() => ({ stages: window.__starmap?.state?.stages ?? [], ready: window.__starmap?.state?.ready === true, error: window.__starmap?.state?.error ?? '' }));
      const now = performance.now();
      if (s.error) return { via, error: s.error };
      for (const stage of s.stages) {
        if (start === null) start = now;
        if (!seen.has(stage)) seen.set(stage, now - start);
      }
      if (s.ready) {
        const info = await page.evaluate(() => {
          const { session } = window.__starmap;
          return { files: session.replica.meta?.stats.files ?? 0, units: session.replica.table('unit').count, edges: session.replica.table('edge').count, structure: session.replica.meta?.structure };
        });
        return { via, totalMs: now - start, stages: Object.fromEntries(seen), ...info };
      }
      if (Date.now() > deadline) return { via, error: 'timed out after 10 minutes' };
      await page.waitForTimeout(20);
    }
  } finally {
    await page.close();
  }
}

// ---- main ----

const args = parseArgs(process.argv.slice(2));
const server = await createServer({ root, logLevel: 'error', server: { host: '127.0.0.1', port: 5187, strictPort: false } });
await server.listen();
const address = server.httpServer.address();
const base = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({
  headless: !args.headed,
  args: ['--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=d3d11', '--enable-unsafe-swiftshader'],
});
const result = { when: new Date().toISOString(), graphics: null, render: [], read: [] };
try {
  result.graphics = await graphics(browser, base);
  console.log(`graphics: ${result.graphics.renderer}`);
  console.log(`logical cores: ${result.graphics.cores}; browser: Chromium ${browser.version()}${args.headed ? '' : ' (headless)'}`);
  if (/swiftshader|llvmpipe|software/i.test(result.graphics.renderer)) {
    console.log('note: this is software rendering, not a GPU. Run with --headed for the machine\'s own adapter.');
  }

  if (args.render) {
    console.log('\nrender (frame time in ms; "moving" is zoom and pan)');
    console.log('"quality" is the adaptive step the renderer ended on (0 = full detail); frames are capped at the display refresh rate');
    console.log(`${pad('files', 9)} ${pad('ready', 8)} ${pad('rest med', 9)} ${pad('rest p95', 9)} ${pad('move med', 9)} ${pad('move p95', 9)} ${pad('worst', 7)} ${pad('move fps', 9)} ${pad('edges', 8)} ${pad('quality', 8)}`);
    for (const size of args.sizes) {
      const r = await benchRender(browser, base, size);
      result.render.push(r);
      if (r.error) { console.log(`${pad(size.toLocaleString('en-US'), 9)} failed: ${r.error}`); continue; }
      console.log(`${pad(size.toLocaleString('en-US'), 9)} ${pad(ms(r.readyMs), 8)} ${pad(ms(r.rest.median), 9)} ${pad(ms(r.rest.p95), 9)} ${pad(ms(r.move.median), 9)} ${pad(ms(r.move.p95), 9)} ${pad(ms(r.move.worst), 7)} ${pad(r.move.fps.toFixed(0), 9)} ${pad((r.stats.edgesDrawn ?? 0).toLocaleString('en-US'), 8)} ${pad(r.stats.quality ?? '—', 8)}`);
    }
  }

  if (args.read && args.repos.length) {
    console.log('\nread paths (ms from the first stage; the folder pipeline in the browser, parsed fresh)');
    for (const repo of args.repos) {
      const name = `bench-${path.basename(repo)}`;
      const bundle = bundleRepo(repo, name);
      console.log(`${path.basename(repo)}: ${bundle.count.toLocaleString('en-US')} files bundled (tracked files and .git), ${(bundle.bytes / 1e6).toFixed(1)} MB`);
      console.log(`${pad('via', 7)} ${pad('run', 4)} ${pad('manifest', 9)} ${pad('reading', 9)} ${pad('structure', 10)} ${pad('layout', 8)} ${pad('total', 8)} ${pad('files', 7)} ${pad('edges', 8)}`);
      for (const via of ['opfs', 'files']) {
        for (let run = 1; run <= args.runs; run++) {
          const r = await benchRead(browser, base, name, via);
          result.read.push({ repo: path.basename(repo), run, ...r });
          if (r.error) { console.log(`${pad(via, 7)} ${pad(run, 4)} failed: ${r.error}`); continue; }
          // a stage's time runs from when it was first seen to when the next one was
          const st = r.stages;
          const end = st.revealed ?? r.totalMs;
          const span = (from, to) => (from == null || to == null ? null : to - from);
          const d = (r.durations = { manifest: st.reading ?? null, reading: span(st.reading, st.structure), structure: span(st.structure, st.layout), layout: span(st.layout, end), total: end });
          console.log(`${pad(via, 7)} ${pad(run, 4)} ${pad(ms(d.manifest), 9)} ${pad(ms(d.reading), 9)} ${pad(ms(d.structure), 10)} ${pad(ms(d.layout), 8)} ${pad(ms(d.total), 8)} ${pad(r.files.toLocaleString('en-US'), 7)} ${pad(r.edges.toLocaleString('en-US'), 8)}`);
        }
      }
    }
    console.log('"opfs" is a FileSystemDirectoryHandle in the origin private file system: the same API calls as a folder the viewer picked, without the disk under it. "files" is the dropped-files path.');
  }
  if (args.json) { mkdirSync(path.dirname(args.json), { recursive: true }); writeFileSync(args.json, JSON.stringify(result, null, 2)); }
} finally {
  await browser.close();
  await server.close();
}
