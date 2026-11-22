// A read-only view of the replica in canonical order. Slots are per-session, so nothing here is
// ordered or keyed by slot: cities, districts and units are sorted by id and referred to by that
// index, and every sum is over integers, so the same model gives the same view in any session.
import type { ModelReplica } from '../../contracts/store';
import { cityRef, districtRef, unitRef } from '../../model/types';
import type { EdgeKind, NodeRef } from '../../model/types';
import type { PathRules } from './filters';
import { cmpStr } from './seeded';
import { LOCAL } from './tunables';

/** Unit flags. A unit with any flag is counted in the structure and never shown. */
export const EXCLUDED = 1, TEST = 2, SECRET = 4;

export interface UnitInfo {
  index: number;
  id: string;
  ref: NodeRef;
  /** Canonical district and city index; −1 while the unit has no district. */
  district: number;
  city: number;
  loc: number;
  lang: string;
  importance: number;
  fanIn: number;
  fanOut: number;
  /** Links (either direction) to other files of its own district, and of its own city. */
  linksInDistrict: number;
  linksInCity: number;
  /** Its files' paths, the primary file first. */
  files: string[];
  flags: number;
}

/** Measured facts about a set of units. */
export interface GroupStats {
  files: number;
  loc: number;
  /** Test files, and vendored / generated / withheld files: counted here, shown nowhere. */
  tests: number;
  hidden: number;
  /** Language shares by lines (by files when no lines are known), largest first. */
  langs: [lang: string, share: number][];
  /** Deepest directories that still hold a substantial share of the files, largest first. */
  prefixes: [dir: string, share: number][];
}

export interface DistrictInfo extends GroupStats {
  index: number;
  id: string;
  ref: NodeRef;
  name: string;
  city: number;
  units: number[];
}

export interface CityInfo extends GroupStats {
  index: number;
  id: string;
  ref: NodeRef;
  name: string;
  districts: number[];
  units: number;
}

/** Aggregated dependency links to one other city or district. */
export interface Link {
  to: number;
  /** Summed weight × confidence, in thousandths (an integer, so the sum is order-independent). */
  milli: number;
  /** Unit-to-unit edges. */
  n: number;
}

export interface View {
  name: string;
  units: UnitInfo[];
  districts: DistrictInfo[];
  cities: CityInfo[];
  unitIndex: Map<string, number>;
  /** Unit index by file path (a unit can hold two files). */
  unitOfFile: Map<string, number>;
  totals: GroupStats & { edges: number; unplaced: number };
  /** Per city / district: what it depends on (out) and what depends on it (in), strongest first. */
  cityOut: Link[][];
  cityIn: Link[][];
  districtOut: Link[][];
  districtIn: Link[][];
}

/** Live slots of a table in id order, and each slot's position in that order (−1 for an empty slot). */
function canonical(ids: readonly (string | null)[], capacity: number): { order: number[]; indexOfSlot: Int32Array } {
  const order: number[] = [];
  for (let s = 0; s < capacity; s++) if (ids[s] !== null) order.push(s);
  order.sort((a, b) => cmpStr(ids[a]!, ids[b]!));
  const indexOfSlot = new Int32Array(capacity).fill(-1);
  order.forEach((slot, i) => { indexOfSlot[slot] = i; });
  return { order, indexOfSlot };
}

function topShares(counts: Map<string, number>, total: number, max: number, minShare: number): [string, number][] {
  if (total <= 0) return [];
  return [...counts]
    .map(([k, n]): [string, number] => [k, n / total])
    .filter(([, share]) => share >= minShare)
    .sort((a, b) => b[1] - a[1] || cmpStr(a[0], b[0]))
    .slice(0, max);
}

/**
 * Dominant path prefixes: the deepest directories that each still hold at least `prefixMinShare`
 * of the paths. '' is the repository root.
 */
function dominantPrefixes(paths: readonly string[]): [string, number][] {
  const total = paths.length;
  if (total === 0) return [];
  const counts = new Map<string, number>();
  for (const path of paths) {
    for (let i = path.lastIndexOf('/'); i > 0; i = path.lastIndexOf('/', i - 1)) {
      const dir = path.slice(0, i);
      counts.set(dir, (counts.get(dir) ?? 0) + 1);
    }
  }
  counts.set('', total);
  const need = total * LOCAL.structure.prefixMinShare;
  const hasDeeper = new Set<string>();
  for (const [dir, n] of counts) {
    if (n < need || dir === '') continue;
    const i = dir.lastIndexOf('/');
    hasDeeper.add(i < 0 ? '' : dir.slice(0, i));
  }
  const deepest = new Map<string, number>();
  for (const [dir, n] of counts) if (n >= need && !hasDeeper.has(dir)) deepest.set(dir, n);
  return topShares(deepest, total, LOCAL.structure.prefixes, 0);
}

function groupStats(units: readonly UnitInfo[]): GroupStats {
  let files = 0, loc = 0, tests = 0, hidden = 0;
  const byLoc = new Map<string, number>(), byFiles = new Map<string, number>();
  const paths: string[] = [];
  for (const u of units) {
    const n = u.files.length;
    files += n;
    loc += u.loc;
    if (u.flags & TEST) tests += n;
    else if (u.flags) hidden += n;
    byLoc.set(u.lang, (byLoc.get(u.lang) ?? 0) + u.loc);
    byFiles.set(u.lang, (byFiles.get(u.lang) ?? 0) + n);
    paths.push(u.id);
  }
  const { langs, langMinShare } = LOCAL.structure;
  return {
    files, loc, tests, hidden,
    langs: loc > 0 ? topShares(byLoc, loc, langs, langMinShare) : topShares(byFiles, files, langs, langMinShare),
    prefixes: dominantPrefixes(paths),
  };
}

function toLinks(agg: Map<number, { milli: number; n: number }>, size: number): { out: Link[][]; in: Link[][] } {
  const out: Link[][] = Array.from({ length: size }, () => []);
  const inn: Link[][] = Array.from({ length: size }, () => []);
  for (const [key, v] of agg) {
    const from = Math.floor(key / size), to = key % size;
    out[from].push({ to, milli: v.milli, n: v.n });
    inn[to].push({ to: from, milli: v.milli, n: v.n });
  }
  const strongest = (a: Link, b: Link) => b.milli - a.milli || b.n - a.n || a.to - b.to;
  for (const list of out) list.sort(strongest);
  for (const list of inn) list.sort(strongest);
  return { out, in: inn };
}

export function buildView(replica: ModelReplica, rules: PathRules): View {
  const cityT = replica.table('city'), districtT = replica.table('district');
  const unitT = replica.table('unit'), fileT = replica.table('file'), edgeT = replica.table('edge');

  const cityOrder = canonical(cityT.ids, cityT.capacity);
  const cities: CityInfo[] = cityOrder.order.map((slot, index) => {
    const id = cityT.ids[slot]!;
    return {
      index, id, ref: cityRef(id), name: cityT.cols.name[slot] ?? '', districts: [], units: 0,
      files: 0, loc: 0, tests: 0, hidden: 0, langs: [], prefixes: [],
    };
  });

  const districtOrder = canonical(districtT.ids, districtT.capacity);
  const districts: DistrictInfo[] = districtOrder.order.map((slot, index) => {
    const id = districtT.ids[slot]!;
    const citySlot = districtT.refSlots.city[slot];
    const city = citySlot >= 0 ? cityOrder.indexOfSlot[citySlot] : -1;
    if (city >= 0) cities[city].districts.push(index);
    return {
      index, id, ref: districtRef(id), name: districtT.cols.name[slot] ?? '', city, units: [],
      files: 0, loc: 0, tests: 0, hidden: 0, langs: [], prefixes: [],
    };
  });

  const unitOrder = canonical(unitT.ids, unitT.capacity);
  const unitIndex = new Map<string, number>();
  let unplaced = 0;
  const units: UnitInfo[] = unitOrder.order.map((slot, index) => {
    const id = unitT.ids[slot]!;
    const districtSlot = unitT.refSlots.district[slot];
    const district = districtSlot >= 0 ? districtOrder.indexOfSlot[districtSlot] : -1;
    const city = district >= 0 ? districts[district].city : -1;
    if (district >= 0 && city >= 0) districts[district].units.push(index);
    else unplaced++;
    unitIndex.set(id, index);
    const c = unitT.cols;
    return {
      index, id, ref: unitRef(id), district: city >= 0 ? district : -1, city,
      loc: c.loc[slot], lang: c.lang[slot], importance: c.importancePct[slot], fanIn: c.fanIn[slot], fanOut: c.fanOut[slot],
      linksInDistrict: 0, linksInCity: 0, files: [], flags: 0,
    };
  });

  const unitOfFile = new Map<string, number>();
  for (let slot = 0; slot < fileT.capacity; slot++) {
    const path = fileT.ids[slot];
    if (path === null) continue;
    const unitSlot = fileT.refSlots.unit[slot];
    const u = unitSlot >= 0 ? unitOrder.indexOfSlot[unitSlot] : -1;
    if (u < 0) continue;
    units[u].files.push(path);
    unitOfFile.set(path, u);
  }
  for (const u of units) {
    if (u.files.length === 0) { u.files.push(u.id); unitOfFile.set(u.id, u.index); }
    // Primary file first, then the rest by path.
    u.files.sort((a, b) => (a === u.id ? -1 : b === u.id ? 1 : cmpStr(a, b)));
    if (rules.excluded(u.id)) u.flags |= EXCLUDED;
    else if (rules.test(u.id)) u.flags |= TEST;
    for (const path of u.files) if (rules.secret(path)) u.flags |= SECRET;
  }

  for (const d of districts) Object.assign(d, groupStats(d.units.map((i) => units[i])));
  for (const c of cities) {
    const members = c.districts.flatMap((d) => districts[d].units).map((i) => units[i]);
    c.units = members.length;
    Object.assign(c, groupStats(members));
  }
  const totals = { ...groupStats(units), prefixes: [], edges: edgeT.count, unplaced };

  const C = cities.length, D = districts.length;
  const cityAgg = new Map<number, { milli: number; n: number }>();
  const districtAgg = new Map<number, { milli: number; n: number }>();
  const bump = (agg: Map<number, { milli: number; n: number }>, key: number, milli: number) => {
    const v = agg.get(key);
    if (v) { v.milli += milli; v.n++; } else agg.set(key, { milli, n: 1 });
  };
  const { weight, confidence } = edgeT.cols;
  const { src, dst } = edgeT.refSlots;
  for (let slot = 0; slot < edgeT.capacity; slot++) {
    if (edgeT.ids[slot] === null || src[slot] < 0 || dst[slot] < 0) continue;
    const a = units[unitOrder.indexOfSlot[src[slot]]], b = units[unitOrder.indexOfSlot[dst[slot]]];
    if (!a || !b || a === b || a.district < 0 || b.district < 0) continue;
    if (a.city === b.city) { a.linksInCity++; b.linksInCity++; }
    if (a.district === b.district) { a.linksInDistrict++; b.linksInDistrict++; continue; }
    const milli = Math.round(weight[slot] * confidence[slot] * 1000);
    bump(districtAgg, a.district * D + b.district, milli);
    if (a.city !== b.city) bump(cityAgg, a.city * C + b.city, milli);
  }
  const cityLinks = toLinks(cityAgg, C), districtLinks = toLinks(districtAgg, D);

  return {
    name: replica.meta?.name ?? '',
    units, districts, cities, unitIndex, unitOfFile, totals,
    cityOut: cityLinks.out, cityIn: cityLinks.in, districtOut: districtLinks.out, districtIn: districtLinks.in,
  };
}

export interface Neighbour {
  unit: number;
  kind: EdgeKind;
  milli: number;
  /** Top referenced symbols on the edge, as [name, count]. */
  symbols: [string, number][];
}

/** One unit's direct dependencies (out) and dependents (in), strongest first. One pass over the edges. */
export function neighboursOf(replica: ModelReplica, view: View, unit: number): { out: Neighbour[]; in: Neighbour[] } {
  const edgeT = replica.table('edge'), unitT = replica.table('unit');
  const slot = unitT.slotOf(view.units[unit].id);
  const out: Neighbour[] = [], inn: Neighbour[] = [];
  const { src, dst } = edgeT.refSlots;
  const { weight, confidence, kind, symbols } = edgeT.cols;
  for (let e = 0; e < edgeT.capacity; e++) {
    if (edgeT.ids[e] === null || (src[e] !== slot && dst[e] !== slot) || src[e] === dst[e]) continue;
    const otherSlot = src[e] === slot ? dst[e] : src[e];
    const otherId = otherSlot >= 0 ? unitT.ids[otherSlot] : null;
    const other = otherId == null ? undefined : view.unitIndex.get(otherId);
    if (other === undefined) continue;
    const parsed: [string, number][] = [];
    for (const part of symbols[e] ? symbols[e].split('|') : []) {
      const i = part.lastIndexOf(':');
      if (i > 0) parsed.push([part.slice(0, i), Number(part.slice(i + 1)) || 1]);
    }
    (src[e] === slot ? out : inn).push({
      unit: other, kind: kind[e], milli: Math.round(weight[e] * confidence[e] * 1000), symbols: parsed,
    });
  }
  const strongest = (a: Neighbour, b: Neighbour) => b.milli - a.milli || a.unit - b.unit;
  return { out: out.sort(strongest), in: inn.sort(strongest) };
}
