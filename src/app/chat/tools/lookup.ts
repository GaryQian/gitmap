// Finding what a tool argument names on the map: a file by its path, a city or district by its ref
// (or, loosely, by its name), a language by its id. When nothing matches, the nearest real names are
// offered so the model can correct itself. Pure: reads the replica only.
import uFuzzy from '@leeoniya/ufuzzy';
import type { ModelReplica } from '../../../contracts/store';
import { cityRef, districtRef, unitRef, type NodeRef } from '../../../model/types';
import { CHAT_UI } from '../tunables';

// ---- files ----

export interface FileHit {
  /** The path as the map spells it. */
  path: string;
  /** Slot in the file table, or −1 when the path is known only as a unit id. */
  fileSlot: number;
  /** The sphere it belongs to; −1 for a file with no unit (it can be read, not selected). */
  unitSlot: number;
  /** The unit's ref, for selecting and flying; null without a unit. */
  ref: NodeRef | null;
}

/** A path as a model may write it: with a leading "./" or "/", backslashes, a ref prefix or a ":line" tail. */
export function cleanPath(raw: string): string {
  let path = raw.trim().replace(/\\/g, '/');
  if (/^[fu]:/.test(path)) path = path.slice(2);
  path = path.replace(/^(\.\/)+/, '').replace(/^\/+/, '');
  return path.replace(/(:\d+(-\d+)?)+$/, '');
}

export function findFile(replica: ModelReplica, raw: string): FileHit | null {
  const path = cleanPath(raw);
  if (path === '') return null;
  const files = replica.table('file'), units = replica.table('unit');
  const f = files.slotOf(path);
  if (f >= 0) {
    const u = files.refSlots.unit?.[f] ?? -1;
    const unitId = u >= 0 ? units.ids[u] : null;
    return { path, fileSlot: f, unitSlot: unitId == null ? -1 : u, ref: unitId == null ? null : unitRef(unitId) };
  }
  const u = units.slotOf(path);
  return u >= 0 ? { path, fileSlot: -1, unitSlot: u, ref: unitRef(path) } : null;
}

/** Every path on the map: the file table, or the unit ids while files have not arrived. */
export function allPaths(replica: ModelReplica): string[] {
  const files = replica.table('file');
  const table = files.count > 0 ? files : replica.table('unit');
  const out: string[] = [];
  for (let s = 0; s < table.capacity; s++) {
    const id = table.ids[s];
    if (id != null) out.push(id);
  }
  return out;
}

const baseOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** How many trailing path segments two paths share. */
function sharedTail(a: string, b: string): number {
  const x = a.split('/'), y = b.split('/');
  let n = 0;
  while (n < x.length && n < y.length && x[x.length - 1 - n] === y[y.length - 1 - n]) n++;
  return n;
}

/** Real paths nearest to one that is not on the map: the same file name first, then a fuzzy match. */
export function suggestFiles(replica: ModelReplica, raw: string, count: number = CHAT_UI.suggestions): string[] {
  const wanted = cleanPath(raw).toLowerCase();
  if (wanted === '') return [];
  const paths = allPaths(replica);
  const base = baseOf(wanted);
  const stem = base.replace(/\.[^.]*$/, '');
  const scored: { path: string; score: number }[] = [];
  for (const path of paths) {
    const lower = path.toLowerCase();
    const tail = sharedTail(lower, wanted);
    if (tail > 0) scored.push({ path, score: 10 + tail });
    else if (stem.length >= 3 && baseOf(lower).includes(stem)) scored.push({ path, score: 5 });
    else if (wanted.length >= 3 && lower.includes(wanted)) scored.push({ path, score: 4 });
  }
  scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length || (a.path < b.path ? -1 : 1));
  const out = scored.slice(0, count).map((s) => s.path);
  if (out.length >= count) return out;
  try {
    const fuzzy = new uFuzzy({ intraMode: 1, intraIns: 1, intraSub: 1, intraTrn: 1, intraDel: 1 });
    const [idxs, info, order] = fuzzy.search(paths, base, 0, 1000);
    const ranked = info && order ? order.map((i) => info.idx[i]!) : idxs ?? [];
    for (const i of ranked) {
      const path = paths[i]!;
      if (!out.includes(path)) out.push(path);
      if (out.length >= count) break;
    }
  } catch {
    // a name uFuzzy cannot turn into a pattern: the plain matches stand
  }
  return out;
}

// ---- cities and districts ----

export interface AreaHit {
  kind: 'city' | 'district';
  slot: number;
  ref: NodeRef;
  /** Its own name ("Shaders"). */
  name: string;
  /** How a sentence names it: "Rendering", or "Shaders in Rendering" for a district. */
  label: string;
  /** The city it is, or is in. */
  citySlot: number;
}

const nameOr = (name: string | undefined, id: string): string => (name && name.trim() ? name : id);

export function cityAt(replica: ModelReplica, slot: number): AreaHit | null {
  const cities = replica.table('city');
  const id = slot >= 0 ? cities.ids[slot] : null;
  if (id == null) return null;
  const name = nameOr(cities.cols.name[slot], id);
  return { kind: 'city', slot, ref: cityRef(id), name, label: name, citySlot: slot };
}

export function districtAt(replica: ModelReplica, slot: number): AreaHit | null {
  const districts = replica.table('district');
  const id = slot >= 0 ? districts.ids[slot] : null;
  if (id == null) return null;
  const name = nameOr(districts.cols.name[slot], id);
  const citySlot = districts.refSlots.city?.[slot] ?? -1;
  const city = cityAt(replica, citySlot);
  return { kind: 'district', slot, ref: districtRef(id), name, label: city ? `${name} in ${city.name}` : name, citySlot };
}

/** Every city, then every district, in slot order. */
export function allAreas(replica: ModelReplica): AreaHit[] {
  const out: AreaHit[] = [];
  for (const s of replica.table('city').slots()) { const hit = cityAt(replica, s); if (hit) out.push(hit); }
  for (const s of replica.table('district').slots()) { const hit = districtAt(replica, s); if (hit) out.push(hit); }
  return out;
}

/** A city or district by its ref ("c:3", "d:12"), or by its exact name when exactly one area has it. */
export function findArea(replica: ModelReplica, raw: string): AreaHit | null {
  const text = raw.trim();
  if (text.startsWith('c:')) return cityAt(replica, replica.table('city').slotOf(text.slice(2)));
  if (text.startsWith('d:')) return districtAt(replica, replica.table('district').slotOf(text.slice(2)));
  const wanted = text.toLowerCase();
  if (wanted === '') return null;
  const named = allAreas(replica).filter((a) => a.name.toLowerCase() === wanted);
  if (named.length === 1) return named[0]!;
  // a city and a district may share a name: the city is the one meant
  const cities = named.filter((a) => a.kind === 'city');
  return cities.length === 1 ? cities[0]! : null;
}

/** Shared pairs of neighbouring letters, 0..1 (Dice's coefficient): cheap, and kind to typos. */
export function likeness(a: string, b: string): number {
  const pairs = (s: string): Map<string, number> => {
    const out = new Map<string, number>();
    const t = ` ${s.toLowerCase()} `;
    for (let i = 0; i < t.length - 1; i++) { const p = t.slice(i, i + 2); out.set(p, (out.get(p) ?? 0) + 1); }
    return out;
  };
  const x = pairs(a), y = pairs(b);
  let shared = 0, total = 0;
  for (const [p, n] of x) { shared += Math.min(n, y.get(p) ?? 0); total += n; }
  for (const n of y.values()) total += n;
  return total === 0 ? 0 : (2 * shared) / total;
}

/** Areas nearest to a name or ref that matched nothing, written "c:3 (Rendering)". */
export function suggestAreas(replica: ModelReplica, raw: string, count: number = CHAT_UI.suggestions): string[] {
  const text = raw.trim();
  const prefixed = /^[cd]:/.test(text);
  const pool = allAreas(replica).filter((a) => !prefixed || a.ref.startsWith(text.slice(0, 2)));
  const wanted = prefixed ? text.slice(2) : text;
  return pool
    .map((a) => ({ a, score: Math.max(likeness(wanted, a.name), likeness(wanted, a.ref.slice(2))) }))
    .sort((p, q) => q.score - p.score || (p.a.kind === q.a.kind ? p.a.slot - q.a.slot : p.a.kind === 'city' ? -1 : 1))
    .slice(0, count)
    .map(({ a }) => `${a.ref} (${a.label})`);
}

/** Where a unit sits. */
export function placeOf(replica: ModelReplica, unitSlot: number): { district: AreaHit | null; city: AreaHit | null } {
  const d = unitSlot >= 0 ? replica.table('unit').refSlots.district?.[unitSlot] ?? -1 : -1;
  const district = districtAt(replica, d);
  return { district, city: district ? cityAt(replica, district.citySlot) : null };
}

/** Live unit slots inside a city or a district, ascending. */
export function unitsIn(replica: ModelReplica, area: AreaHit): number[] {
  const units = replica.table('unit');
  const unitDistrict = units.refSlots.district ?? [];
  const districtCity = replica.table('district').refSlots.city ?? [];
  const out: number[] = [];
  for (let s = 0; s < units.capacity; s++) {
    if (units.ids[s] == null) continue;
    const d = unitDistrict[s] ?? -1;
    if (d < 0) continue;
    if (area.kind === 'district' ? d === area.slot : districtCity[d] === area.slot) out.push(s);
  }
  return out;
}

// ---- languages ----

export interface MapLanguage { id: string; name: string; files: number; lines: number }

/** The languages on the map, most files first. One sphere is one file here, as in the legend. */
export function mapLanguages(replica: ModelReplica): MapLanguage[] {
  const units = replica.table('unit');
  const byId = new Map<string, MapLanguage>();
  for (let s = 0; s < units.capacity; s++) {
    if (units.ids[s] == null) continue;
    const id = units.cols.lang[s] || 'other';
    let row = byId.get(id);
    if (!row) byId.set(id, row = { id, name: replica.meta?.languages?.[id]?.name ?? (id === 'other' ? 'Other' : id), files: 0, lines: 0 });
    row.files++;
    row.lines += units.cols.loc[s] ?? 0;
  }
  return [...byId.values()].sort((a, b) => b.files - a.files || (a.id < b.id ? -1 : 1));
}

/** A language id on the map, from its id or its display name in any case. */
export function findLanguage(languages: readonly MapLanguage[], raw: string): MapLanguage | null {
  const wanted = raw.trim().toLowerCase();
  return languages.find((l) => l.id.toLowerCase() === wanted) ?? languages.find((l) => l.name.toLowerCase() === wanted) ?? null;
}
