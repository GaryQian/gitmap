// Layout benchmark (IMPLEMENTATION.md 6E): cluster sizes and layout quality for a parsed repo.
// It loads a snapshot written by "npm run parse", re-runs clustering and physics on its units and edges
// with the current code and config, and prints:
//   - city and district sizes (how even they are; the largest of each)
//   - settle time and whether everything came to rest
//   - overlap: pairs of spheres closer than their radii allow
//   - fill: how evenly files occupy a district (a dense core with a thin halo scores low)
//   - gaps: sibling districts should touch, cities should keep physics.city.gap between them
// Nothing here fails on a threshold; the numbers are for comparing before and after a change.
//
// Usage: node scripts/run.mjs scripts/bench/layout.ts <in.starmap.json.gz> [out.starmap.json.gz]
//          [--cap ms]         settle time cap (default reveal.settleMaxMs)
//          [--keep-clusters]  lay out the snapshot's own cities and districts instead of re-clustering
//          [--no-physics]     sizes only
//          [--diag]           what the twelve largest districts consist of
// The optional output snapshot can be looked at with /dev.html?snapshot=/out/<name>.starmap.json.gz.
import { readFileSync, writeFileSync } from 'node:fs';
import { cluster } from '../../src/analysis/cluster';
import type { UnitEdges } from '../../src/analysis/edges';
import type { UnitTable } from '../../src/analysis/units';
import { config } from '../../src/config';
import { createModelStore, decodeModel, encodeModel } from '../../src/model';
import type { EdgeKind, StructureTables } from '../../src/model/types';
import { createPhysicsEngine } from '../../src/physics';
import { unitRadius } from '../../src/shared';
import { tablesToOps } from '../../src/testing/synthetic';

const pct = (xs: number[], p: number) => { if (!xs.length) return 0; const s = xs.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const f1 = (x: number) => x.toFixed(1);

export default async function main(args: string[]): Promise<void> {
  const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--cap');
  const capAt = args.indexOf('--cap');
  const capMs = capAt >= 0 ? Number(args[capAt + 1]) : config.reveal.settleMaxMs;
  const model = await decodeModel(new Uint8Array(readFileSync(positional[0])));
  const ut = model.tables.unit, et = model.tables.edge;
  const n = ut.ids.length;

  // UnitTable / UnitEdges as the analysis stages pass them to cluster()
  const unitIndex = new Map(ut.ids.map((id, i) => [id, i]));
  const units: UnitTable = {
    count: n, ids: ut.ids, primaryFile: ut.cols.primaryFile!, fileCount: ut.cols.fileCount!, loc: ut.cols.loc!, bytes: ut.cols.bytes!,
    lang: ut.cols.lang!, fileUnit: Int32Array.from({ length: n }, (_, i) => i), unitOfFile: unitIndex,
  };
  const order = et.ids.map((_, i) => i).sort((a, b) => {
    const sa = unitIndex.get(et.cols.src![a])!, sb = unitIndex.get(et.cols.src![b])!;
    return sa - sb || unitIndex.get(et.cols.dst![a])! - unitIndex.get(et.cols.dst![b])!;
  });
  const m = order.length;
  const edges: UnitEdges = {
    count: m,
    src: Int32Array.from(order, (e) => unitIndex.get(et.cols.src![e])!),
    dst: Int32Array.from(order, (e) => unitIndex.get(et.cols.dst![e])!),
    kind: order.map((e) => et.cols.kind![e] as EdgeKind),
    weight: Float64Array.from(order, (e) => et.cols.weight![e]),
    confidence: Float64Array.from(order, (e) => et.cols.confidence![e]),
    mechanism: order.map(() => ''), symbols: order.map(() => ''),
    fanIn: Int32Array.from(ut.cols.fanIn!), fanOut: Int32Array.from(ut.cols.fanOut!),
  };

  let tables: StructureTables = { city: model.tables.city, district: model.tables.district, unit: ut, file: model.tables.file, edge: et };
  if (!args.includes('--keep-clusters')) {
    const t0 = performance.now();
    const c = cluster(units, edges, config, undefined, model.meta.name);
    console.log(`cluster: ${(performance.now() - t0).toFixed(0)} ms`);
    tables = {
      city: { ids: c.cities.map((x) => x.id), cols: { name: c.cities.map((x) => x.name) } },
      district: { ids: c.districts.map((x) => x.id), cols: { city: c.districts.map((x) => x.city), name: c.districts.map((x) => x.name) } },
      unit: { ids: ut.ids, cols: { ...ut.cols, district: c.unitDistrict } },
      file: model.tables.file,
      edge: et,
    };
  }

  // ---- cluster sizes ----
  const districtCity = new Map(tables.district.ids.map((id, i) => [id, tables.district.cols.city![i]]));
  const dSize = new Map<string, number>(), cSize = new Map<string, number>();
  for (const d of tables.unit.cols.district!) { dSize.set(d, (dSize.get(d) ?? 0) + 1); const c = districtCity.get(d)!; cSize.set(c, (cSize.get(c) ?? 0) + 1); }
  const ds = [...dSize.values()], cs = [...cSize.values()];
  console.log(`units ${n}, edges ${m}`);
  console.log(`cities ${cs.length}: sizes ${cs.sort((a, b) => b - a).join(' ')}`);
  console.log(`districts ${ds.length}: max ${Math.max(...ds)}, p90 ${pct(ds, 0.9)}, median ${pct(ds, 0.5)}, min ${Math.min(...ds)}; top ${ds.slice().sort((a, b) => b - a).slice(0, 8).join(' ')}`);
  const perCity = new Map<string, number>();
  for (const c of districtCity.values()) perCity.set(c, (perCity.get(c) ?? 0) + 1);
  console.log(`districts per city: ${[...perCity.values()].sort((a, b) => b - a).join(' ')}`);

  if (args.includes('--diag')) {
    const connected = new Uint8Array(n);
    for (let e = 0; e < m; e++) { connected[edges.src[e]] = 1; connected[edges.dst[e]] = 1; }
    const membersOf = new Map<string, number[]>();
    tables.unit.cols.district!.forEach((d, u) => { let a = membersOf.get(d); if (!a) membersOf.set(d, (a = [])); a.push(u); });
    for (const [d, us] of [...membersOf].sort((a, b) => b[1].length - a[1].length).slice(0, 12)) {
      const dirs = new Map<string, number>();
      let conn = 0;
      for (const u of us) { const p = ut.ids[u]; const dir = p.slice(0, Math.max(0, p.lastIndexOf('/'))); dirs.set(dir, (dirs.get(dir) ?? 0) + 1); conn += connected[u]; }
      const top = [...dirs].sort((a, b) => b[1] - a[1])[0];
      console.log(`  ${us.length} files · ${dirs.size} dirs · top dir ${top[0]} (${top[1]}) · with code edges ${conn} · district ${d} in ${districtCity.get(d)}`);
    }
  }
  if (args.includes('--no-physics')) return;

  // ---- physics ----
  const store = createModelStore();
  const physics = createPhysicsEngine({ config, capacity: { units: n + 16, districts: ds.length + 16, cities: cs.length + 16 } });
  store.subscribe((b) => physics.applyBatch(b));
  store.propose([{ op: 'meta', value: { ...model.meta } }, ...tablesToOps(tables)]);
  const report = await physics.settle(capMs);
  console.log(`settle: ${report.ms.toFixed(0)} ms, ${report.ticks} ticks, atRest ${report.atRest}, overlapShare ${(report.overlapShare * 100).toFixed(1)}%`);

  // ---- layout quality from the buffers ----
  const rep = store.replica;
  const U = rep.table('unit'), D = rep.table('district'), C = rep.table('city');
  const P = physics.positions;
  const byDistrict = new Map<number, number[]>();
  for (const u of U.slots()) { const d = U.refSlots.district[u]; let a = byDistrict.get(d); if (!a) byDistrict.set(d, (a = [])); a.push(u); }
  const radius = (u: number) => unitRadius(U.cols.loc[u], U.cols.importancePct[u], config.visual);
  let overlapPairs = 0, deepPairs = 0, checked = 0;
  const fills: number[] = [], haloShare: number[] = [];
  for (const [d, us] of byDistrict) {
    const R = P.district[3 * d + 2];
    let area = 0;
    for (const u of us) area += Math.PI * radius(u) ** 2;
    if (us.length >= 20) {
      fills.push(area / (Math.PI * R * R));
      // share of the district's radius beyond which only 10% of the sphere area lives: 1 = even fill, small = dense core + thin halo
      const byDist = us.map((u) => ({ r: Math.hypot(P.unit[2 * u], P.unit[2 * u + 1]), a: radius(u) ** 2 })).sort((x, y) => x.r - y.r);
      const total = byDist.reduce((s, x) => s + x.a, 0);
      let acc = 0, r90 = 0;
      for (const x of byDist) { acc += x.a; if (acc >= 0.9 * total) { r90 = x.r; break; } }
      haloShare.push(r90 / Math.max(1e-9, byDist[byDist.length - 1].r));
    }
    // exact pair check with a simple grid
    const cell = 2 * config.visual.radiusMax * (1 + config.visual.importanceBoost);
    const grid = new Map<string, number[]>();
    for (const u of us) { const k = `${Math.floor(P.unit[2 * u] / cell)},${Math.floor(P.unit[2 * u + 1] / cell)}`; let a = grid.get(k); if (!a) grid.set(k, (a = [])); a.push(u); }
    for (const u of us) {
      const gx = Math.floor(P.unit[2 * u] / cell), gy = Math.floor(P.unit[2 * u + 1] / cell);
      for (let ix = gx - 1; ix <= gx + 1; ix++) for (let iy = gy - 1; iy <= gy + 1; iy++) {
        for (const v of grid.get(`${ix},${iy}`) ?? []) {
          if (v <= u) continue;
          checked++;
          const dist = Math.hypot(P.unit[2 * u] - P.unit[2 * v], P.unit[2 * u + 1] - P.unit[2 * v + 1]);
          const sum = radius(u) + radius(v);
          if (dist < sum * 0.98) overlapPairs++;
          if (dist < sum * 0.75) deepPairs++;
        }
      }
    }
  }
  console.log(`unit pairs overlapping (<98% of rA+rB): ${overlapPairs}; deeply (<75%): ${deepPairs} (of ${checked} near pairs)`);
  console.log(`district fill (sphere area / district area), districts ≥ 20 files: median ${pct(fills, 0.5).toFixed(2)}, p10 ${pct(fills, 0.1).toFixed(2)}, min ${Math.min(...fills).toFixed(2)}`);
  console.log(`radius holding 90% of sphere area / outermost sphere: median ${pct(haloShare, 0.5).toFixed(2)}, p10 ${pct(haloShare, 0.1).toFixed(2)} (1 = even, low = core + halo)`);

  // districts: gap to the nearest sibling, relative to their radii (0 = touching, <0 = overlapping)
  const dByCity = new Map<number, number[]>();
  for (const d of D.slots()) { const c = D.refSlots.city[d]; let a = dByCity.get(c); if (!a) dByCity.set(c, (a = [])); a.push(d); }
  const dGaps: number[] = [];
  let districtOverlaps = 0;
  for (const dsl of dByCity.values()) {
    if (dsl.length < 2) continue;
    for (const a of dsl) {
      let best = Infinity;
      for (const b of dsl) {
        if (a === b) continue;
        const gap = Math.hypot(P.district[3 * a] - P.district[3 * b], P.district[3 * a + 1] - P.district[3 * b + 1]) - P.district[3 * a + 2] - P.district[3 * b + 2];
        if (gap < best) best = gap;
      }
      dGaps.push(best);
      if (best < -0.5) districtOverlaps++;
    }
  }
  console.log(`district gap to nearest sibling (world units): median ${f1(pct(dGaps, 0.5))}, p90 ${f1(pct(dGaps, 0.9))}, max ${f1(Math.max(...dGaps))}; districts overlapping a sibling: ${districtOverlaps}`);
  const cSlots = C.slots();
  let minCityGap = Infinity;
  const cGaps: number[] = [];
  for (const a of cSlots) {
    let best = Infinity;
    for (const b of cSlots) {
      if (a === b) continue;
      const gap = Math.hypot(P.city[3 * a] - P.city[3 * b], P.city[3 * a + 1] - P.city[3 * b + 1]) - P.city[3 * a + 2] - P.city[3 * b + 2];
      if (gap < best) best = gap;
    }
    cGaps.push(best);
    if (best < minCityGap) minCityGap = best;
  }
  console.log(`city gap to nearest city: min ${f1(minCityGap)}, median ${f1(pct(cGaps, 0.5))}, max ${f1(Math.max(...cGaps))} (config physics.city.gap = ${config.physics.city.gap})`);
  console.log(`city radii: ${cSlots.map((c) => P.city[3 * c + 2].toFixed(0)).join(' ')}`);

  if (positional[1]) {
    writeFileSync(positional[1], await encodeModel(store.toModel(await physics.getLayout())));
    console.log(`wrote ${positional[1]}`);
  }
  physics.dispose();
}
