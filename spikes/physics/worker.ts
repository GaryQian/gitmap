// Physics worker: settle, then a time-sliced scheduler that ticks only hot sims and writes SAB positions.
import { probe, realSetTimeout } from "./timer-probe.ts"; // must be first: wraps timers before d3-timer loads
import { buildAndSettle, pickDistrict } from "./experiments.ts";
import { type Layout, type Sim, snapshot, displacement } from "./layout.ts";

const SLICE_MS = 8;
const FRAME_MS = 1000 / 60;
const EXTRA_CAPACITY = 2000; // room for incremental adds

let L: Layout;
let sims: { sim: Sim; tier: 0 | 1 | 2; idx: number }[] = [];
let cityBuf: Float32Array, districtBuf: Float32Array, fileBuf: Float32Array, seq: Int32Array;
let J = 0;
// seq layout: [0]=city seqlock, [1]=district seqlock, [2]=file seqlock, [3..3+J) per-district gen,
// [3+J]=hot city sims, [4+J]=hot district sims, [5+J]=hot file sims, [6+J]=loop count
let stats: any[] = [];
let lastLoopStart = 0;
const post = (m: any) => (self as any).postMessage(m);

function isHot(s: Sim) {
  return s.alpha() >= s.alphaMin() || s.alphaTarget() >= s.alphaMin();
}

function writeCity() {
  Atomics.add(seq, 0, 1); // odd: writing
  for (const n of L.cityNodes) { cityBuf[3 * n.i] = n.x; cityBuf[3 * n.i + 1] = n.y; cityBuf[3 * n.i + 2] = n.r; }
  Atomics.add(seq, 0, 1); // even: stable
}
function writeDistricts(c: number) {
  Atomics.add(seq, 1, 1);
  for (const d of L.g.cityDistricts[c]) { const n = L.districtNodes[d]; districtBuf[3 * d] = n.x; districtBuf[3 * d + 1] = n.y; districtBuf[3 * d + 2] = n.r; }
  Atomics.add(seq, 1, 1);
}
function writeFiles(d: number) {
  Atomics.add(seq, 2, 1);
  for (const n of L.files[d].nodes) { fileBuf[2 * n.i] = n.x; fileBuf[2 * n.i + 1] = n.y; }
  Atomics.add(seq, 2, 1);
  Atomics.add(seq, 3 + d, 1);
}

function publishHot() {
  const hot = [0, 0, 0];
  for (const e of sims) if (isHot(e.sim)) hot[e.tier]++;
  Atomics.store(seq, 3 + J, hot[0]); Atomics.store(seq, 4 + J, hot[1]); Atomics.store(seq, 5 + J, hot[2]);
}

function loop() {
  const t0 = performance.now();
  const interval = lastLoopStart ? t0 - lastLoopStart : 0;
  lastLoopStart = t0;
  const ticked = [0, 0, 0];
  const touched: typeof sims = [];
  // order: city, districts, files (camera-distance sort omitted: no camera in this spike)
  for (const e of sims) {
    if (!isHot(e.sim)) continue;
    if (performance.now() - t0 >= SLICE_MS) break; // slice exhausted: rest waits for next loop
    e.sim.tick();
    ticked[e.tier]++;
    touched.push(e);
  }
  const tTick = performance.now();
  for (const e of touched) {
    if (e.tier === 0) writeCity();
    else if (e.tier === 1) writeDistricts(e.idx);
    else writeFiles(e.idx);
  }
  const tWrite = performance.now();
  publishHot();
  Atomics.add(seq, 6 + J, 1);
  if (touched.length) stats.push({ t: t0, interval, tickMs: tTick - t0, writeMs: tWrite - tTick, city: ticked[0], district: ticked[1], file: ticked[2], cityAlpha: L.citySim.alpha() });
  realSetTimeout(loop, Math.max(0, FRAME_MS - (performance.now() - t0)));
}

let addCtx: any = null;

self.onmessage = (ev: MessageEvent) => {
  const m = ev.data;
  if (m.type === "init") {
    const probeBefore = { ...probe, log: [...probe.log] };
    const { L: lay, report } = buildAndSettle(m.files);
    L = lay;
    const probeAfterSettle = { ...probe, log: [...probe.log] };
    J = L.g.nDistricts;
    const K = L.g.nCities;
    const cap = L.g.nFiles + EXTRA_CAPACITY;
    let sabOk = true, sabError = "";
    try {
      cityBuf = new Float32Array(new SharedArrayBuffer(K * 3 * 4));
      districtBuf = new Float32Array(new SharedArrayBuffer(J * 3 * 4));
      fileBuf = new Float32Array(new SharedArrayBuffer(cap * 2 * 4));
      seq = new Int32Array(new SharedArrayBuffer((J + 8) * 4));
    } catch (e) { sabOk = false; sabError = String(e); }
    if (!sabOk) { post({ type: "ready", sabOk, sabError, crossOriginIsolated: (self as any).crossOriginIsolated, report }); return; }
    writeCity();
    for (let c = 0; c < K; c++) writeDistricts(c);
    for (let d = 0; d < J; d++) writeFiles(d);
    sims = [
      { sim: L.citySim, tier: 0, idx: 0 },
      ...L.districtSims.map((sim, idx) => ({ sim, tier: 1 as const, idx })),
      ...L.files.map((f, idx) => ({ sim: f.sim, tier: 2 as const, idx })),
    ];
    const fileDistrict = new Int32Array(cap).fill(-1);
    fileDistrict.set(L.g.fileDistrict);
    post({
      type: "ready", sabOk, crossOriginIsolated: (self as any).crossOriginIsolated,
      workerHasSAB: typeof SharedArrayBuffer === "function",
      report, probeBefore, probeAfterSettle,
      cityBuf, districtBuf, fileBuf, seq, J, K, nFiles: L.g.nFiles,
      districtCity: L.g.districtCity, fileDistrict, defaultAddDistrict: pickDistrict(L),
    });
    // check again later: did d3-timer's setTimeout(17)/setInterval(1000) fire and clean up?
    realSetTimeout(() => post({ type: "probe", probe: { ...probe, log: probe.log.slice(0, 20) }, tickEvents: L.tickEvents }), 1500);
    loop();
  } else if (m.type === "dragStart") {
    const n = L.cityNodes[m.city];
    n.fx = n.x; n.fy = n.y;
    L.citySim.alphaTarget(0.3);
    stats = [];
  } else if (m.type === "dragMove") {
    const n = L.cityNodes[m.city];
    n.fx = m.x; n.fy = m.y;
  } else if (m.type === "dragEnd") {
    const n = L.cityNodes[m.city];
    n.fx = null; n.fy = null;
    L.citySim.alphaTarget(0);
    post({ type: "dragEnded", statsDuringDrag: stats.length });
  } else if (m.type === "add") {
    const d = m.district ?? pickDistrict(L);
    const p = L.files[d];
    const c = L.g.districtCity[d];
    const existing = p.nodes.slice();
    addCtx = {
      d, c, existing, t0: performance.now(),
      before: snapshot(existing),
      beforeDistricts: snapshot(L.g.cityDistricts[c].map((k) => L.districtNodes[k])),
      beforeCities: snapshot(L.cityNodes),
    };
    stats = [];
    const nBefore = L.fileNodes.length;
    const tA = performance.now();
    L.addFiles(d, m.count ?? 200, m.mode ?? "plan");
    addCtx.addCallMs = performance.now() - tA;
    publishHot();
    // new nodes are global ids nBefore.. : tell main thread their district
    post({ type: "added", d, from: nBefore, to: L.fileNodes.length });
  } else if (m.type === "addResult") {
    const a = addCtx;
    const sibs = L.g.cityDistricts[a.c].map((k: number) => L.districtNodes[k]);
    post({
      type: "addResult",
      wallMs: performance.now() - a.t0, addCallMs: a.addCallMs,
      fileDisp: displacement(a.existing, a.before), districtDisp: displacement(sibs, a.beforeDistricts),
      cityDisp: displacement(L.cityNodes, a.beforeCities), districtR: L.districtR[a.d],
      loops: stats.length, ticksFile: stats.reduce((s, x) => s + x.file, 0), ticksDistrict: stats.reduce((s, x) => s + x.district, 0), ticksCity: stats.reduce((s, x) => s + x.city, 0),
      maxTickMs: Math.max(...stats.map((x) => x.tickMs)), meanTickMs: stats.reduce((s, x) => s + x.tickMs, 0) / stats.length,
    });
  } else if (m.type === "getStats") {
    post({ type: "stats", stats, tickEvents: L.tickEvents, probe: { ...probe, log: probe.log.slice(0, 20) } });
    if (m.reset) stats = [];
  }
};
