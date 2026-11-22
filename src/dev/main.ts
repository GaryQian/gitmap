// /dev harness: load a synthetic model or a saved snapshot straight into the renderer, so visuals
// and physics can be iterated on without parsing anything. Lead-owned.
//   /dev.html?n=10000&seed=1          synthetic model through the real session (store, physics worker, renderer)
//   /dev.html?snapshot=/out/react.starmap.json.gz   a snapshot written by `npm run parse`
//   /dev.html?fake=1&n=2000           the fake session: static layout, no workers
//   /dev.html?fixture=three-lang&via=opfs|files|memory   a fixture repo through the folder pipeline.
//        A second load comes back from the snapshot the first one saved (state.fromSnapshot);
//        add &fresh=1 to parse again, ignoring the saved map and the cached parse facts.
//   &mode=dark|light
//   window.__starmap exposes the session for tests and the console.
import { config } from '../config';
import type { RepoLocator } from '../contracts/git';
import type { RepoSource, Session } from '../contracts/pipeline';
import { decodeModel } from '../model';
import { createSession } from '../pipeline';
import { createFakeSession } from '../testing/fakeSession';

const qs = new URLSearchParams(location.search);
const n = Number(qs.get('n') ?? 1000);
const seed = Number(qs.get('seed') ?? 1);
const mode = qs.get('mode') === 'light' ? 'light' : 'dark';
const hud = document.getElementById('hud')!;
const canvas = document.getElementById('scene') as HTMLCanvasElement;
if (mode === 'light') { document.body.style.background = config.theme.light.void; document.body.style.color = config.theme.light.text; }

const state = {
  ready: false, spheres: 0, error: '',
  /** Stages seen, in order, without repeats. */
  stages: [] as string[],
  /** The folder was shown from its stored snapshot: it was revealed without a 'reading' stage. */
  fromSnapshot: false,
  /** Notices raised so far ("N files changed", "no history", …). */
  notices: [] as unknown[],
};
const handle: { session: Session | null; render: unknown; state: typeof state } = { session: null, render: null, state };
(window as unknown as { __starmap: unknown }).__starmap = handle;

/**
 * A fixture repo (written by scripts/bundle-fixture.ts) as a locator, so the folder pipeline runs in
 * a browser with no folder picker: 'opfs' gives a real FileSystemDirectoryHandle, 'files' the
 * dropped-files path, 'memory' plain bytes.
 */
async function fixtureLocator(name: string, via: string): Promise<RepoLocator> {
  hud.textContent = `loading fixture ${name}`;
  const res = await fetch(`/out/fixtures/${name}.json`);
  if (!res.ok) throw new Error(`fixture bundle missing: run "node scripts/run.mjs scripts/bundle-fixture.ts ${name}"`);
  const bundle = (await res.json()) as { name: string; files: Record<string, string> };
  const bytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  if (via === 'memory') return { kind: 'memory', name, files: Object.fromEntries(Object.entries(bundle.files).map(([p, b]) => [p, bytes(b)])) };
  if (via === 'files') return { kind: 'files', name, files: Object.entries(bundle.files).map(([p, b]) => ({ path: p, file: new File([bytes(b)], p.split('/').pop()!) })) };
  const opfs = await navigator.storage.getDirectory();
  const parent = await opfs.getDirectoryHandle('starmap-dev-fixtures', { create: true });
  try { await parent.removeEntry(name, { recursive: true }); } catch { /* first run */ }
  const root = await parent.getDirectoryHandle(name, { create: true });
  for (const [p, b] of Object.entries(bundle.files)) {
    const segs = p.split('/');
    let dir = root;
    for (const s of segs.slice(0, -1)) dir = await dir.getDirectoryHandle(s, { create: true });
    const w = await (await dir.getFileHandle(segs[segs.length - 1], { create: true })).createWritable();
    await w.write(bytes(b));
    await w.close();
  }
  return { kind: 'fsa', root };
}

async function open(): Promise<Session> {
  if (qs.has('fake')) return createFakeSession(config, { files: n, seed, waitMs: Number(qs.get('wait') ?? 0) });
  let source: RepoSource = { kind: 'synthetic', files: n, seed };
  const fixture = qs.get('fixture');
  if (fixture) return createSession({ kind: 'directory', locator: await fixtureLocator(fixture, qs.get('via') ?? 'opfs'), fresh: qs.has('fresh') }, config);
  const snapshot = qs.get('snapshot');
  if (snapshot) {
    hud.textContent = `loading ${snapshot}`;
    const res = await fetch(snapshot);
    if (!res.ok) throw new Error(`${snapshot}: ${res.status}`);
    source = { kind: 'snapshot', model: await decodeModel(new Uint8Array(await res.arrayBuffer())) };
  }
  return createSession(source, config);
}

open().then(async (session) => {
  handle.session = session;
  const render = session.attachCanvas(canvas, { theme: mode });
  handle.render = render;
  session.on('stage', (s) => {
    hud.textContent = s.label || s.stage;
    if (state.stages.at(-1) !== s.stage) state.stages.push(s.stage);
  });
  session.on('notice', (n) => { state.notices.push(n); });
  session.on('error', (e) => { state.error = e.message; hud.textContent = `error: ${e.message}`; });
  await session.start();
  state.ready = true;
  state.fromSnapshot = session.source.kind === 'directory' && !state.stages.includes('reading');
  state.spheres = session.replica.table('unit').count;
  const tick = () => {
    const s = render.stats();
    hud.textContent = `${session.replica.meta?.name ?? ''} · ${state.spheres.toLocaleString()} spheres · ${session.replica.table('edge').count.toLocaleString()} edges\n${s.fps.toFixed(0)} fps · ${s.frameMs.toFixed(1)} ms · quality ${s.quality} · resyncs ${s.resyncs}`;
  };
  tick();
  setInterval(tick, 500);
}).catch((err) => { state.error = String(err?.message ?? err); hud.textContent = `failed: ${state.error}`; });
