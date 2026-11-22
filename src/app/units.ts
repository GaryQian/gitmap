// Reading units out of the replica for the chrome: names, languages, neighbours. Pure, no React.
import type { ModelReplica } from '../contracts/store';
import { cityTitle } from './cityNames';
import { parseRef, unitRef, type NodeRef, type RepoMeta } from '../model/types';
import { basename } from '../shared';

/** Unit slot of a `u:` or `f:` ref, or −1 (a city or district ref, or a node that is gone). */
export function unitSlotOf(replica: ModelReplica, ref: NodeRef): number {
  let parsed;
  try { parsed = parseRef(ref); } catch { return -1; }
  if (parsed.kind === 'unit') return replica.table('unit').slotOf(parsed.id);
  if (parsed.kind !== 'file') return -1;
  const files = replica.table('file');
  const f = files.slotOf(parsed.id);
  return f < 0 ? -1 : (files.refSlots.unit?.[f] ?? -1);
}

/** Display name of a language: the plug-in's name from the model, else the id itself. */
export function languageName(meta: RepoMeta | null, lang: string): string {
  return meta?.languages?.[lang]?.name ?? (lang === 'other' ? 'Other' : lang);
}

/** What a tooltip or a pill needs to know about one unit. */
export interface UnitSummary {
  ref: NodeRef;
  slot: number;
  /** The unit id: its primary file's path. */
  path: string;
  name: string;
  lang: string;
  langName: string;
  loc: number;
  bytes: number;
  importancePct: number;
  fanIn: number;
  fanOut: number;
  fileCount: number;
}

export function unitSummary(replica: ModelReplica, ref: NodeRef): UnitSummary | null {
  const slot = unitSlotOf(replica, ref);
  const units = replica.table('unit');
  const path = slot < 0 ? null : units.ids[slot];
  if (path == null) return null;
  const c = units.cols;
  const lang = c.lang[slot] ?? 'other';
  return {
    ref, slot, path, name: basename(path), lang, langName: languageName(replica.meta, lang),
    loc: c.loc[slot] ?? 0, bytes: c.bytes[slot] ?? 0, importancePct: c.importancePct[slot] ?? 0, fanIn: c.fanIn[slot] ?? 0, fanOut: c.fanOut[slot] ?? 0,
    fileCount: c.fileCount[slot] ?? 1,
  };
}

/** File name of a unit ref for a pill, or null when the node is gone. */
export function unitName(replica: ModelReplica, ref: NodeRef): string | null {
  const slot = unitSlotOf(replica, ref);
  const id = slot < 0 ? null : replica.table('unit').ids[slot];
  return id == null ? null : basename(id);
}

export interface Neighbor { ref: NodeRef; name: string; path: string }
export interface UnitDetails extends UnitSummary {
  /** Paths of the unit's files, primary first: two for a header + implementation pair. */
  files: string[];
  district: string;
  city: string;
  /** Units that depend on this one (edges pointing at it), heaviest first, up to the asked limit. */
  dependents: Neighbor[];
  dependentCount: number;
  /** Units this one depends on. */
  dependencies: Neighbor[];
  dependencyCount: number;
}

/** Everything the detail card shows. Scans the edge and file tables once, so call it per selection, not per frame. */
export function unitDetails(replica: ModelReplica, ref: NodeRef, namesShown: number): UnitDetails | null {
  const summary = unitSummary(replica, ref);
  if (!summary) return null;
  const { slot } = summary;
  const units = replica.table('unit'), districts = replica.table('district'), cities = replica.table('city');

  const d = units.refSlots.district?.[slot] ?? -1;
  const c = d < 0 ? -1 : (districts.refSlots.city?.[d] ?? -1);

  const files = [summary.path];
  if (summary.fileCount > 1) {
    const table = replica.table('file');
    const owner = table.refSlots.unit ?? [];
    for (let f = 0; f < table.capacity; f++) {
      const id = table.ids[f];
      if (id != null && owner[f] === slot && id !== summary.path) files.push(id);
    }
  }

  const edges = replica.table('edge');
  const src = edges.refSlots.src ?? [], dst = edges.refSlots.dst ?? [], weight = edges.cols.weight;
  const incoming: [number, number][] = [], outgoing: [number, number][] = [];
  for (let e = 0; e < edges.capacity; e++) {
    if (edges.ids[e] == null) continue;
    if (dst[e] === slot && src[e] !== slot) incoming.push([src[e]!, weight[e] ?? 1]);
    else if (src[e] === slot && dst[e] !== slot) outgoing.push([dst[e]!, weight[e] ?? 1]);
  }
  const top = (list: [number, number][]): Neighbor[] =>
    list.sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, namesShown).flatMap(([u]) => {
      const id = units.ids[u];
      return id == null ? [] : [{ ref: unitRef(id), name: basename(id), path: id }];
    });

  return {
    ...summary, files,
    district: d < 0 ? '' : (districts.cols.name[d] ?? ''),
    city: c < 0 ? '' : cityTitle(replica, cities.ids[c]),
    dependents: top(incoming),
    // the columns are right before the edges have arrived, and the edges are right once they have
    dependentCount: Math.max(incoming.length, edges.count === 0 ? summary.fanIn : 0),
    dependencies: top(outgoing),
    dependencyCount: Math.max(outgoing.length, edges.count === 0 ? summary.fanOut : 0),
  };
}

/** "97th", "1st", "22nd". */
export function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${suffix}`;
}

/**
 * An importance percentile (0..1) as words: "97th percentile". The percentile is among the files
 * that have dependents; 0 marks a file that has none, which is not ranked.
 */
export function percentileLabel(importancePct: number): string {
  if (!(importancePct > 0)) return 'Unranked: no dependents';
  const pct = Math.min(99, Math.max(1, Math.round(importancePct * 100)));
  return `${ordinal(pct)} percentile`;
}

export function countLabel(n: number, one: string, many: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/** "812 bytes", "14 KB", "2 MB", "5.3 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  const shown = value >= 10 || Math.abs(value - Math.round(value)) < 0.05 ? String(Math.round(value)) : value.toFixed(1);
  return `${shown} ${units[unit]}`;
}
