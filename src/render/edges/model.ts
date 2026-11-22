// Everything the edge levels derive from the model, rebuilt lazily from the replica (not on every
// batch of a burst): per-edge strength, ribbons per district pair and city pair, the edges of each
// district and of each unit. No three.js here.
import type { Config } from '../../config';
import type { ModelReplica } from '../../contracts/store';
import { glowAmount } from '../../shared';
import { aggregateRibbons, rollUpRibbons, type Ribbon } from './aggregate';
import { EDGE_LOCAL } from './tunables';

const NEVER_HIDDEN = 1e9;

export interface EdgeModel {
  /** Edge slots covered. */
  capacity: number;
  /** Unit slots of each edge (−1 for an empty slot): src is the dependent, dst what it depends on. */
  src: Int32Array;
  dst: Int32Array;
  /** Weight × confidence; 0 when the edge cannot be drawn (empty slot, an endpoint without a district). */
  eff: Float32Array;
  /** What edges are ranked by: `eff`, reduced when an endpoint is dimmed, 0 when one is hidden by the size slider. */
  rank: Float32Array;
  /** Brightness: lower for low confidence and for a dimmed endpoint. */
  bright: Float32Array;
  /** 1 when an endpoint is dimmed by the type filter. */
  dim: Uint8Array;
  /** The size slider hides the edge above this line count (either endpoint hidden). */
  hideAt: Float32Array;
  /** Per unit: the line count above which the slider hides it. */
  unitHideAt: Float32Array;
  /** Mean `eff` of drawable edges: the reference for strength01. */
  typical: number;
  unitDistrict: Int32Array;
  districtCity: Int32Array;
  /** Strongest first. */
  districtRibbons: Ribbon[];
  cityRibbons: Ribbon[];
  /** Edges touching each district (CSR over district slots); a list is sorted strongest first on first use. */
  districtOffsets: Int32Array;
  districtEdges: Int32Array;
  districtSorted: Uint8Array;
  /** Edges touching each unit (CSR over unit slots), built on first use. */
  unitOffsets: Int32Array | null;
  unitEdges: Int32Array | null;
}

export function buildEdgeModel(replica: ModelReplica, visual: Config['visual'], minLines: number, typeFilter: readonly string[]): EdgeModel {
  const edges = replica.table('edge'), units = replica.table('unit'), districts = replica.table('district');
  const E = edges.capacity, U = units.capacity, D = districts.capacity;

  const districtCity = new Int32Array(D).fill(-1);
  for (let d = 0; d < D; d++) if (districts.ids[d] != null) districtCity[d] = districts.refSlots.city[d] ?? -1;
  const unitDistrict = new Int32Array(U).fill(-1);
  const unitHideAt = new Float32Array(U);
  const unitDim = new Uint8Array(U);
  const shown = typeFilter.length ? new Set(typeFilter) : null;
  for (let u = 0; u < U; u++) {
    if (units.ids[u] == null) continue;
    const d = units.refSlots.district[u] ?? -1;
    unitDistrict[u] = d >= 0 && d < D && districtCity[d] >= 0 ? d : -1;
    // glowing files are exempt from the size slider (PLAN.md §8.1)
    unitHideAt[u] = glowAmount(units.cols.importancePct[u], visual) > 0 ? NEVER_HIDDEN : units.cols.loc[u];
    if (shown && !shown.has(units.cols.lang[u])) unitDim[u] = 1;
  }

  const src = new Int32Array(E).fill(-1), dst = new Int32Array(E).fill(-1);
  const eff = new Float32Array(E), rank = new Float32Array(E), bright = new Float32Array(E), hideAt = new Float32Array(E);
  const dim = new Uint8Array(E);
  const srcSlots = edges.refSlots.src, dstSlots = edges.refSlots.dst, weight = edges.cols.weight, confidence = edges.cols.confidence;
  let sum = 0, n = 0;
  const perDistrict = new Int32Array(D + 1);
  for (let e = 0; e < E; e++) {
    if (edges.ids[e] == null) continue;
    const s = srcSlots[e] ?? -1, t = dstSlots[e] ?? -1;
    if (s < 0 || t < 0 || s === t || s >= U || t >= U) continue;
    const ds = unitDistrict[s], dt = unitDistrict[t];
    if (ds < 0 || dt < 0) continue;
    src[e] = s; dst[e] = t;
    const conf = Math.min(1, Math.max(0, confidence[e] ?? 1));
    const w = Math.max(0, weight[e] ?? 1) * Math.max(0.05, conf);
    if (!(w > 0)) continue;
    eff[e] = w;
    dim[e] = unitDim[s] | unitDim[t];
    hideAt[e] = Math.min(unitHideAt[s], unitHideAt[t]);
    bright[e] = (EDGE_LOCAL.lowConfidence + (1 - EDGE_LOCAL.lowConfidence) * conf) * (dim[e] ? EDGE_LOCAL.dimmed : 1);
    rank[e] = hideAt[e] < minLines ? 0 : w * (dim[e] ? EDGE_LOCAL.dimmed : 1);
    sum += w; n++;
    if (rank[e] > 0) { perDistrict[ds]++; if (dt !== ds) perDistrict[dt]++; }
  }

  const districtRibbons = aggregateRibbons({ count: E, src, dst, weight: rank, dim }, unitDistrict);
  const cityRibbons = rollUpRibbons(districtRibbons, districtCity);
  const byWeight = (a: Ribbon, b: Ribbon) => b.weight - a.weight || a.a - b.a || a.b - b.b;
  districtRibbons.sort(byWeight);
  cityRibbons.sort(byWeight);

  const districtOffsets = new Int32Array(D + 1);
  for (let d = 0; d < D; d++) districtOffsets[d + 1] = districtOffsets[d] + perDistrict[d];
  const districtEdges = new Int32Array(districtOffsets[D]);
  const cursor = districtOffsets.slice(0, D);
  for (let e = 0; e < E; e++) {
    if (!(rank[e] > 0)) continue;
    const ds = unitDistrict[src[e]], dt = unitDistrict[dst[e]];
    districtEdges[cursor[ds]++] = e;
    if (dt !== ds) districtEdges[cursor[dt]++] = e;
  }

  return {
    capacity: E, src, dst, eff, rank, bright, dim, hideAt, unitHideAt, typical: n ? sum / n : 1, unitDistrict, districtCity,
    districtRibbons, cityRibbons, districtOffsets, districtEdges, districtSorted: new Uint8Array(D), unitOffsets: null, unitEdges: null,
  };
}

/** The edges touching a district, strongest first (sorted on first use, then cached). */
export function edgesOfDistrict(model: EdgeModel, district: number): Int32Array {
  if (district < 0 || district + 1 >= model.districtOffsets.length) return new Int32Array(0);
  const list = model.districtEdges.subarray(model.districtOffsets[district], model.districtOffsets[district + 1]);
  if (!model.districtSorted[district]) {
    const rank = model.rank;
    list.sort((a, b) => rank[b] - rank[a] || a - b);
    model.districtSorted[district] = 1;
  }
  return list;
}

/** The drawable edges touching a unit, in slot order. */
export function edgesOfUnit(model: EdgeModel, unit: number): Int32Array {
  if (!model.unitOffsets || !model.unitEdges) {
    const U = model.unitDistrict.length;
    const offsets = new Int32Array(U + 1);
    for (let e = 0; e < model.capacity; e++) if (model.eff[e] > 0) { offsets[model.src[e] + 1]++; offsets[model.dst[e] + 1]++; }
    for (let u = 0; u < U; u++) offsets[u + 1] += offsets[u];
    const list = new Int32Array(offsets[U]);
    const cursor = offsets.slice(0, U);
    for (let e = 0; e < model.capacity; e++) if (model.eff[e] > 0) { list[cursor[model.src[e]]++] = e; list[cursor[model.dst[e]]++] = e; }
    model.unitOffsets = offsets; model.unitEdges = list;
  }
  if (unit < 0 || unit + 1 >= model.unitOffsets.length) return new Int32Array(0);
  return model.unitEdges.subarray(model.unitOffsets[unit], model.unitOffsets[unit + 1]);
}
