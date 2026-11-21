// Experiments shared by the Node bench and the browser worker.
import { generate } from "./graph.ts";
import { Layout, snapshot, displacement, type Sim, type LayoutOpts } from "./layout.ts";

export function buildAndSettle(files: number, seed = 1, opts: LayoutOpts = {}) {
  const t0 = performance.now();
  const g = generate({ files, seed });
  const tGen = performance.now() - t0;
  const t1 = performance.now();
  const L = new Layout(g, 7, opts);
  const tBuild = performance.now() - t1;
  const settle = L.settle();
  const t2 = performance.now();
  const quality = L.quality();
  const tQuality = performance.now() - t2;
  const filesPerDistrict = g.districtFiles.map((f) => f.length);
  return {
    L,
    report: {
      files, cities: g.nCities, districts: g.nDistricts,
      fileEdges: g.fileEdges.reduce((a, e) => a + e.length, 0),
      maxFilesPerDistrict: Math.max(...filesPerDistrict),
      minFilesPerDistrict: Math.min(...filesPerDistrict),
      genMs: tGen, buildMs: tBuild, settle, quality, qualityMs: tQuality,
      checksum: L.checksum(), timerTickEvents: L.tickEvents,
    },
  };
}

/** Pick the largest district of a mid-sized city so the add is a realistic "busy" case. */
export function pickDistrict(L: Layout): number {
  const ds = L.g.cityDistricts[3];
  return ds.reduce((best, d) => (L.files[d].nodes.length > L.files[best].nodes.length ? d : best), ds[0]);
}

export function runToRestRoundRobin(sims: Sim[]) {
  const ticks = new Map<Sim, number>(sims.map((s) => [s, 0]));
  const t0 = performance.now();
  let hot = sims.filter((s) => s.alpha() >= s.alphaMin());
  while (hot.length) {
    for (const s of hot) { s.tick(); ticks.set(s, ticks.get(s)! + 1); }
    hot = hot.filter((s) => s.alpha() >= s.alphaMin());
  }
  return { ms: performance.now() - t0, ticks: sims.map((s) => ticks.get(s)!) };
}

export function incrementalAdd(L: Layout, d: number, count: number, mode: "plan" | "stable") {
  const p = L.files[d];
  const c = L.g.districtCity[d];
  const existing = p.nodes.slice();
  const siblings = L.g.cityDistricts[c].map((k) => L.districtNodes[k]);
  const before = { files: snapshot(existing), districts: snapshot(siblings), cities: snapshot(L.cityNodes) };
  const R0 = L.districtR[d], CR0 = L.cityR[c];
  const tA = performance.now();
  const sims = L.addFiles(d, count, mode);
  const addMs = performance.now() - tA;
  const rest = runToRestRoundRobin(sims);
  const fileDisp = displacement(existing, before.files);
  const sibDisp = displacement(siblings.filter((n) => n.i !== d), before.districts.filter((_, k) => Math.floor(k / 2) !== siblings.findIndex((n) => n.i === d)));
  const ownDistrictIdx = siblings.findIndex((n) => n.i === d);
  const ownDistrictMove = Math.hypot(siblings[ownDistrictIdx].x - before.districts[2 * ownDistrictIdx], siblings[ownDistrictIdx].y - before.districts[2 * ownDistrictIdx + 1]);
  const cityDisp = displacement(L.cityNodes, before.cities);
  return {
    mode, district: d, city: c, existingFiles: existing.length, added: count,
    districtR: [R0, L.districtR[d]], cityR: [CR0, L.cityR[c]],
    addMs, restMs: rest.ms, ticks: { city: rest.ticks[0], district: rest.ticks[1], file: rest.ticks[2] },
    fileDisp: { ...fileDisp, meanPctOfR: (100 * fileDisp.mean) / R0, maxPctOfR: (100 * fileDisp.max) / R0 },
    ownDistrictMove,
    siblingDistrictDisp: sibDisp,
    cityDisp,
  };
}
