// The physics worker: the engine behind a time-sliced loop (PLAN.md §7.3). Ported from
// spikes/physics/worker.ts.
//
// The loop runs one scheduler slice of config.physics.sliceMs per frame interval and stops when
// nothing is hot; any command wakes it. Positions reach the page through SharedArrayBuffers when the
// page could allocate them (cross-origin isolated); otherwise changed rows are posted at about 30 Hz.
//
// d3-timer needs no shim here: it finds no `window`, falls back to setTimeout, and each simulation is
// stopped at construction, so it leaves a short self-cleaning burst of timers and nothing scheduled
// (measured with spikes/physics/timer-probe.ts).
import { GEN_ANY, GEN_CITY, GEN_DISTRICT0, GEN_HOT, GEN_REV } from '../contracts/physics';
import { capacityOf } from './buffers';
import { createEngine, type PhysicsEngineInternal } from './engine';
import type { FromWorker, ToWorker } from './protocol';
import { tuningFrom } from './tuning';

const scope = self as unknown as DedicatedWorkerGlobalScope;
const post = (m: FromWorker, transfer: Transferable[] = []) => scope.postMessage(m, transfer);

let engine: PhysicsEngineInternal | null = null;
let shared = false;
let sliceMs = 8;
let frameMs = 1000 / 60;
let postMs = 1000 / 30;
let timer: ReturnType<typeof setTimeout> | null = null;
let lastPost = 0;
let lastAtHome = true;
/** Copy mode: the counters as of the last post, to find the rows that changed since. */
let sent = new Int32Array(0);

function publishState(): void {
  if (!engine) return;
  const atHome = engine.isAtHome();
  if (atHome !== lastAtHome) post({ type: 'state', atHome: (lastAtHome = atHome) });
}

/** Copy mode: post every row whose generation moved since the last post. */
function postPositions(): void {
  if (!engine || shared) return;
  const p = engine.positions, gen = p.gen;
  if (sent.length !== gen.length) {
    const grown = new Int32Array(gen.length);
    grown.set(sent.subarray(0, Math.min(sent.length, gen.length)));
    if (sent.length === 0) grown.fill(-1, 0, GEN_DISTRICT0); // force the first post
    sent = grown;
  }
  if (gen[GEN_ANY] === sent[GEN_ANY] && gen[GEN_REV] === sent[GEN_REV] && gen[GEN_HOT] === sent[GEN_HOT]) return;
  const changed: number[] = [];
  let unitCount = 0;
  for (let i = GEN_DISTRICT0; i < gen.length; i++) {
    if (gen[i] === sent[i]) continue;
    changed.push(i - GEN_DISTRICT0);
    unitCount += engine.unitsOf(i - GEN_DISTRICT0).length;
  }
  const districtSlots = Int32Array.from(changed);
  const districtRows = new Float32Array(changed.length * 3);
  const unitSlots = new Int32Array(unitCount);
  const unitXZ = new Float32Array(unitCount * 2);
  let u = 0;
  changed.forEach((d, k) => {
    districtRows.set(p.district.subarray(3 * d, 3 * d + 3), 3 * k);
    for (const n of engine!.unitsOf(d)) {
      unitSlots[u] = n.slot;
      unitXZ[2 * u] = p.unit[2 * n.slot];
      unitXZ[2 * u + 1] = p.unit[2 * n.slot + 1];
      u++;
    }
  });
  const city = gen[GEN_CITY] !== sent[GEN_CITY] ? p.city.slice() : null;
  const rev = gen[GEN_REV], hot = gen[GEN_HOT];
  sent.set(gen);
  lastPost = performance.now();
  const transfer: Transferable[] = [districtSlots.buffer, districtRows.buffer, unitSlots.buffer, unitXZ.buffer];
  if (city) transfer.push(city.buffer);
  post({ type: 'positions', rev, hot, city, districtSlots, districtRows, unitSlots, unitXZ }, transfer);
}

/** After a command: everything it changed is visible to the page before any reply is posted. */
function publish(): void {
  postPositions();
  publishState();
}

function loop(): void {
  timer = null;
  if (!engine) return;
  const t0 = performance.now();
  const hot = engine.step(sliceMs);
  publishState();
  if (hot === 0 || t0 - lastPost >= postMs) postPositions();
  // idle when nothing is hot: the next command wakes the loop
  if (hot > 0) timer = setTimeout(loop, Math.max(0, frameMs - (performance.now() - t0)));
}

function wake(): void {
  if (timer === null && engine) timer = setTimeout(loop, 0);
}

function reply<T>(id: number, work: Promise<T>, done: (value: T) => void): void {
  work.then(done).catch((err) => post({ type: 'error', message: err instanceof Error ? err.message : String(err), id }));
}

function handle(m: ToWorker): void {
  if (m.type === 'init') {
    const t = tuningFrom(m.config);
    sliceMs = t.sliceMs;
    frameMs = 1000 / t.loopHz;
    postMs = 1000 / t.postHz;
    shared = !!m.buffers;
    engine = createEngine({ config: m.config, capacity: m.capacity, seed: m.seed }, m.buffers ?? undefined);
    engine.onBuffers((b) => post(shared ? { type: 'buffers', buffers: b } : { type: 'capacity', capacity: capacityOf(b) }));
    return;
  }
  if (!engine) throw new Error('physics worker: message before init');
  const e = engine;
  switch (m.type) {
    case 'batch': e.applyBatch(m.batch); publish(); break;
    case 'drag': e.drag(m.ref, m.x, m.z); publishState(); break;
    case 'release': e.release(m.ref); break;
    case 'focus': e.setFocus({ x: m.x, z: m.z }, m.radius); break;
    case 'settle':
      reply(m.id, e.settle(m.maxMs), (report) => { publish(); post({ type: 'settled', id: m.id, report }); });
      break;
    case 'reset':
      reply(m.id, e.resetLayout(), () => { publish(); post({ type: 'resetDone', id: m.id }); });
      break;
    case 'getLayout':
      reply(m.id, e.getLayout(), (layout) => post({ type: 'layout', id: m.id, layout }));
      break;
    case 'loadLayout': e.loadLayout(m.layout); publish(); break;
    case 'dispose':
      if (timer !== null) clearTimeout(timer);
      timer = null;
      e.dispose();
      engine = null;
      return;
  }
  wake();
}

scope.onmessage = (ev: MessageEvent<ToWorker>) => {
  const m = ev.data;
  try {
    handle(m);
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err), id: 'id' in m ? m.id : undefined });
  }
};
