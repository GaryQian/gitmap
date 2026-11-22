// The pure part of the overlay chrome: contributor ordering and matching, what a pill shows for its
// layer, which units a selection seeds Dependency reach from, and what a batch changed. No React.
import uFuzzy from '@leeoniya/ufuzzy';
import type { ModelReplica } from '../../contracts/store';
import { parseRef, type Layer, type NodeRef, type PatchBatch, type RepoMeta } from '../../model/types';
import type { ThemeMode } from '../../config';
import { OVERLAY_COLORS, type HistoryContributor, type OverlayId, type OverlayInfo } from '../../overlays';

// ---- contributors ----

/** Most commits first; ties by name, then by id so the order never flickers. */
export function sortContributors(list: readonly HistoryContributor[]): HistoryContributor[] {
  return [...list].sort((a, b) => b.commits - a.commits || a.name.localeCompare(b.name) || a.id - b.id);
}

let instance: uFuzzy | null = null;
/** One typo per word (a substitution, transposition, insertion or deletion), as the file search allows. */
const matcher = (): uFuzzy => (instance ??= new uFuzzy({ intraMode: 1, intraIns: 1, intraSub: 1, intraTrn: 1, intraDel: 1 }));

/** Accents folded and case dropped, so "jose" finds "José". */
const fold = (text: string): string => uFuzzy.latinize(text).toLowerCase();

/**
 * The contributors a query finds, most commits first. An empty query lists everyone. Words may come
 * in any order. Names that contain every word as typed come before names that only match with a typo.
 */
export function filterContributors(list: readonly HistoryContributor[], query: string): HistoryContributor[] {
  const sorted = sortContributors(list);
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return sorted;
  const names = sorted.map((c) => fold(c.name));

  let near: number[] = [];
  try {
    let idxs: number[] | undefined;
    for (const word of words) {
      idxs = matcher().filter(names, word, idxs) ?? [];
      if (idxs.length === 0) break;
    }
    near = idxs ?? [];
  } catch {
    near = []; // a word uFuzzy cannot turn into a pattern: the plain match below still applies
  }
  const loose = new Set(near);

  const exact: HistoryContributor[] = [], typo: HistoryContributor[] = [];
  for (let i = 0; i < sorted.length; i++) {
    if (words.every((w) => names[i]!.includes(w))) exact.push(sorted[i]!);
    else if (loose.has(i)) typo.push(sorted[i]!);
  }
  return exact.concat(typo);
}

// ---- pills ----

/**
 * What an overlay's pill shows: nothing at all (the overlay can never have data on this map), a
 * quiet pill (no data yet), a progress ring (data still arriving) or a plain pill.
 */
export type PillState =
  | { kind: 'hidden' }
  | { kind: 'pending' }
  | { kind: 'partial'; coverage: number }
  | { kind: 'complete' };

/**
 * True when the history overlays will never get data here: the session said so, the map is a plain
 * folder, or it is a demo or an imported map, which carry whatever layers they were saved with.
 */
export function historyUnavailable(noticed: boolean, source: RepoMeta['source'] | undefined, hasFolder: boolean): boolean {
  return noticed || source === 'folder' || source === 'demo' || (source === 'import' && !hasFolder);
}

export function pillState(
  info: Pick<OverlayInfo, 'layer' | 'needs'>,
  layer: Pick<Layer, 'status' | 'coverage'> | null | undefined,
  noHistory: boolean,
): PillState {
  if (info.layer === null) return { kind: 'complete' }; // computed on demand (Dependency reach)
  const status = layer?.status ?? 'pending';
  if (status === 'complete') return { kind: 'complete' };
  if (status === 'partial') {
    const c = layer?.coverage ?? 0;
    return { kind: 'partial', coverage: c > 0 ? Math.min(1, c) : 0 };
  }
  // hidden rather than shown disabled: nothing will ever fill it in
  return info.needs.history && noHistory ? { kind: 'hidden' } : { kind: 'pending' };
}

/**
 * The progress a screen reader is told about: in quarters (0, 25, 50, 75), so a live region changes a
 * few times while the data arrives instead of on every batch.
 */
export function announcedPercent(coverage: number): number {
  const c = coverage > 0 ? Math.min(1, coverage) : 0;
  return Math.min(75, Math.floor(c * 4) * 25);
}

// ---- the colour an overlay lends the chrome while it is on ----

/** Spread between the strongest and weakest channel of a #rgb / #rrggbb colour; −1 for any other form. */
function vividness(color: string): number {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())?.[1];
  if (!hex) return -1;
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
  const rgb = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  return Math.max(...rgb) - Math.min(...rgb);
}

function mostVivid(colors: readonly string[]): string | null {
  let best: string | null = null;
  let score = -2;
  for (const c of colors) {
    const v = vividness(c);
    if (v > score) { best = c; score = v; }
  }
  return best;
}

/**
 * An overlay's accent, for the active pill and the map's frame: the most saturated colour among
 * `colors` (its legend's). Dependency reach is always its red hot end, even before anything is selected.
 */
export function overlayAccent(id: OverlayId, mode: ThemeMode, colors: readonly string[]): string | null {
  if (id === 'reach') return (mode === 'dark' ? OVERLAY_COLORS.dark.reach[2] : OVERLAY_COLORS.light.reach[0]) ?? null;
  return mostVivid(colors);
}

/** The accent of every overlay on the default palette: what the contrast test measures (theme.test.ts). */
export function paletteAccents(mode: ThemeMode): Record<OverlayId, string | null> {
  const p = OVERLAY_COLORS[mode];
  return {
    recency: overlayAccent('recency', mode, [p.recency]),
    ownership: overlayAccent('ownership', mode, [p.ownership]),
    reach: overlayAccent('reach', mode, p.reach),
    knowledgeRisk: overlayAccent('knowledgeRisk', mode, [p.knowledgeRisk]),
    tests: overlayAccent('tests', mode, Object.values(p.tests)),
  };
}

// ---- Dependency reach seeds ----

/**
 * The unit slots a selection stands for, ascending and without repeats: a file is itself, a
 * district or a city is every file in it. Refs that no longer exist are skipped.
 */
export function seedSlots(selection: readonly NodeRef[], replica: ModelReplica): number[] {
  const units = replica.table('unit');
  const seeds = new Set<number>();
  const districts = new Set<number>(), cities = new Set<number>();
  for (const ref of selection) {
    let kind: ReturnType<typeof parseRef>['kind'], id: string;
    try { ({ kind, id } = parseRef(ref)); } catch { continue; }
    if (kind === 'unit') {
      const s = units.slotOf(id);
      if (s >= 0) seeds.add(s);
    } else if (kind === 'file') {
      const files = replica.table('file');
      const f = files.slotOf(id);
      const s = f >= 0 ? files.refSlots.unit?.[f] ?? -1 : -1;
      if (s >= 0) seeds.add(s);
    } else {
      const s = replica.table(kind).slotOf(id);
      if (s >= 0) (kind === 'district' ? districts : cities).add(s);
    }
  }
  if (districts.size > 0 || cities.size > 0) {
    const unitDistrict = units.refSlots.district ?? [];
    const districtCity = replica.table('district').refSlots.city ?? [];
    for (let s = 0; s < units.capacity; s++) {
      if (units.ids[s] == null) continue;
      const d = unitDistrict[s] ?? -1;
      if (d >= 0 && (districts.has(d) || cities.has(districtCity[d] ?? -1))) seeds.add(s);
    }
  }
  return [...seeds].sort((a, b) => a - b);
}

// ---- what a batch changed ----

export interface Touched {
  /** Layers that received values, a status or side data. */
  layers: Set<string>;
  /** Units, edges, districts or memberships changed: slots, the unit graph and seeds may all differ. */
  structure: boolean;
}

export function batchTouches(batch: PatchBatch): Touched {
  const layers = new Set<string>();
  let structure = batch.full === true;
  for (const op of batch.ops) {
    if (op.op === 'layer') layers.add(op.id);
    else if (op.op === 'assign') structure = true;
    else if (op.op === 'add' || op.op === 'update' || op.op === 'remove') structure ||= op.kind !== 'contributor';
  }
  return { layers, structure };
}

/** Whether a batch calls for the active overlay to be rebuilt. A full batch replaces every layer. */
export function touchesOverlay(touched: Touched, info: Pick<OverlayInfo, 'layer'>): boolean {
  return touched.structure || (info.layer !== null && touched.layers.has(info.layer));
}
