// /dev harness: load a synthetic model (or a saved snapshot) straight into the renderer, so visuals
// and physics can be iterated on without parsing anything. Lead-owned.
//   /dev.html?n=10000&seed=1&mode=dark|light&physics=static|engine|worker&wait=0
//   window.__gitmap exposes the session for tests and the console.
import { config } from '../config';
import { createFakeSession } from '../testing/fakeSession';

const qs = new URLSearchParams(location.search);
const n = Number(qs.get('n') ?? 1000);
const seed = Number(qs.get('seed') ?? 1);
const hud = document.getElementById('hud')!;
const canvas = document.getElementById('scene') as HTMLCanvasElement;

const session = createFakeSession(config, { files: n, seed, waitMs: Number(qs.get('wait') ?? 0) });
const render = session.attachCanvas(canvas);
if (qs.get('mode') === 'light') {
  render.setTheme('light');
  document.body.style.background = config.theme.light.void;
}
session.on('stage', (s) => { hud.textContent = s.label || s.stage; });
session.on('error', (e) => { hud.textContent = `error: ${e.message}`; });

const state = { ready: false, spheres: 0 };
(window as unknown as { __gitmap: unknown }).__gitmap = { session, render, state };

session.start().then(() => {
  state.ready = true;
  state.spheres = session.replica.table('unit').count;
  const tick = () => {
    const s = render.stats();
    hud.textContent = `${state.spheres.toLocaleString()} spheres · ${session.replica.table('edge').count.toLocaleString()} edges\n${s.fps.toFixed(0)} fps · ${s.frameMs.toFixed(1)} ms · quality ${s.quality}`;
  };
  tick();
  setInterval(tick, 500);
}, (err) => { hud.textContent = `failed: ${err?.message ?? err}`; });
