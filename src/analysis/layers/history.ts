// History facts → the Recency, Knowledge risk and Ownership layers (PLAN.md §3.1, §6.5, §10).
// Pure and deterministic. The input may be partial: call again as chunks of the walk land, passing
// the previous result's `state` so each call proposes only the values that changed.
import { config as defaultConfig, type Config } from '../../config';
import type { LayerStatus, ModelPatch } from '../../model/types';
import { LAYER_DEFS, RECENCY_OLDER, type FileHistory, type HistoryInput, type OwnershipExtra } from '../../overlays';
import { unitIndex, type StructureSource, type UnitIndex } from './structure';

export type LayerPatch = Extract<ModelPatch, { op: 'layer' }>;

/** File facts folded into units: counts add, last-modified takes the maximum, first-seen the minimum. */
export interface UnitHistory {
  units: UnitIndex;
  /** Seconds; NaN for a unit none of whose files has history. One entry per unit row, as below. */
  lastModified: Float64Array;
  firstSeen: Float64Array;
  commits: Float64Array;
  /** Author counts per unit row in CSR form, authors in ascending id order. */
  offsets: number[];
  authorIds: number[];
  authorCommits: number[];
}

/** What the last call proposed, per unit row, so the next one can propose only the difference. */
export interface HistoryLayerState {
  unitIds: string[];
  recency: Float64Array;
  knowledgeRisk: Float64Array;
  ownership: Float64Array;
}

export function aggregateHistory(input: HistoryInput, source: StructureSource): UnitHistory {
  const units = unitIndex(source);
  const n = units.unitIds.length;
  const files = input.files;
  const get: (path: string) => FileHistory | undefined = files instanceof Map
    ? (path) => files.get(path)
    : (path) => (Object.prototype.hasOwnProperty.call(files, path) ? files[path] : undefined);

  // facts of each unit's files (usually one; two for a header + implementation pair)
  const facts: (FileHistory | FileHistory[] | undefined)[] = new Array(n);
  for (let f = 0; f < units.filePaths.length; f++) {
    const u = units.fileUnit[f];
    if (u < 0) continue;
    const h = get(units.filePaths[f]);
    if (!h) continue;
    const have = facts[u];
    if (!have) facts[u] = h;
    else if (Array.isArray(have)) have.push(h);
    else facts[u] = [have, h];
  }

  const lastModified = new Float64Array(n).fill(NaN), firstSeen = new Float64Array(n).fill(NaN), commits = new Float64Array(n);
  const offsets: number[] = [0], authorIds: number[] = [], authorCommits: number[] = [];
  const byId = (a: [number, number], b: [number, number]) => a[0] - b[0];
  for (let u = 0; u < n; u++) {
    const have = facts[u];
    if (have && !Array.isArray(have) && ascending(have.authors)) {
      // the common case, one file whose authors are already in order: no merging needed
      lastModified[u] = have.lastModified;
      firstSeen[u] = have.firstSeen;
      commits[u] = have.commits;
      for (const a of have.authors) { authorIds.push(a[0]); authorCommits.push(a[1]); }
    } else if (have) {
      const list = Array.isArray(have) ? have : [have];
      const authors = new Map<number, number>();
      let last = -Infinity, first = Infinity, count = 0;
      for (const h of list) {
        if (h.lastModified > last) last = h.lastModified;
        if (h.firstSeen < first) first = h.firstSeen;
        count += h.commits;
        for (const [id, c] of h.authors) authors.set(id, (authors.get(id) ?? 0) + c);
      }
      lastModified[u] = last === -Infinity ? NaN : last;
      firstSeen[u] = first === Infinity ? NaN : first;
      commits[u] = count;
      for (const [id, c] of [...authors].sort(byId)) { authorIds.push(id); authorCommits.push(c); }
    }
    offsets.push(authorIds.length);
  }
  return { units, lastModified, firstSeen, commits, offsets, authorIds, authorCommits };
}

/** Strictly ascending contributor ids (so no duplicates either). */
function ascending(authors: readonly [number, number][]): boolean {
  for (let i = 1; i < authors.length; i++) if (!(authors[i][0] > authors[i - 1][0])) return false;
  return true;
}

const same = (a: number, b: number) => a === b || (a !== a && b !== b);

/** The rows whose value differs from `prev` (every row when there is no usable `prev`). */
function changed(units: UnitIndex, values: Float64Array, prev: Float64Array | undefined): { unitIds: string[]; values: number[] } {
  if (!prev || prev.length !== values.length) return { unitIds: units.unitIds.slice(), values: Array.from(values) };
  const unitIds: string[] = [], out: number[] = [];
  for (let u = 0; u < values.length; u++) if (!same(values[u], prev[u])) { unitIds.push(units.unitIds[u]); out.push(values[u]); }
  return { unitIds, values: out };
}

function known(values: Float64Array): number {
  let n = 0;
  for (const v of values) if (v === v) n++;
  return n;
}

function walkStatus(input: HistoryInput): LayerStatus {
  return input.complete ? 'complete' : input.coverage > 0 ? 'partial' : 'pending';
}

/**
 * Recency: the last-modified time of each unit, in raw seconds (the overlay does the log-scaled
 * age, so nothing here goes stale as time passes). Complete as soon as every current file has been
 * seen. Units the walk never saw stay unknown while it is partial and become RECENCY_OLDER, "older
 * than the window", once it is complete.
 */
export function recencyValues(agg: UnitHistory, input: HistoryInput): Float64Array {
  const done = input.recencyComplete || input.complete;
  const out = Float64Array.from(agg.lastModified);
  if (done) for (let u = 0; u < out.length; u++) if (out[u] !== out[u]) out[u] = RECENCY_OLDER;
  return out;
}
export function recencyLayer(agg: UnitHistory, input: HistoryInput, prev?: Float64Array, values = recencyValues(agg, input)): LayerPatch {
  const done = input.recencyComplete || input.complete;
  const seen = known(values);
  let oldest = Infinity;
  for (const v of values) if (v > RECENCY_OLDER && v < oldest) oldest = v;
  return {
    op: 'layer', id: 'recency',
    def: { ...LAYER_DEFS.recency, domain: [oldest === Infinity ? input.now : oldest, input.now] },
    ...changed(agg.units, values, prev),
    status: done ? 'complete' : seen > 0 || input.coverage > 0 ? 'partial' : 'pending',
    coverage: done ? 1 : values.length ? seen / values.length : 0,
    extra: { now: input.now },
  };
}

/**
 * Knowledge risk: the top author's share of the commits to each unit. Units with fewer than
 * `overlays.knowledgeRisk.minCommits` commits stay unknown, since a share of two commits means little.
 */
export function knowledgeRiskValues(agg: UnitHistory, minCommits: number): Float64Array {
  const n = agg.units.unitIds.length;
  const out = new Float64Array(n).fill(NaN);
  for (let u = 0; u < n; u++) {
    if (!(agg.commits[u] >= minCommits)) continue;
    let total = 0, top = 0;
    for (let i = agg.offsets[u]; i < agg.offsets[u + 1]; i++) { const c = agg.authorCommits[i]; total += c; if (c > top) top = c; }
    if (total > 0) out[u] = top / total;
  }
  return out;
}
export function knowledgeRiskLayer(
  agg: UnitHistory, input: HistoryInput, cfg: Config = defaultConfig, prev?: Float64Array,
  values = knowledgeRiskValues(agg, cfg.overlays.knowledgeRisk.minCommits),
): LayerPatch {
  return {
    op: 'layer', id: 'knowledgeRisk', def: LAYER_DEFS.knowledgeRisk,
    ...changed(agg.units, values, prev),
    status: walkStatus(input), coverage: input.complete ? 1 : input.coverage,
  };
}

/**
 * Ownership: total commits per unit as the values, and every unit's author counts in `extra`
 * (OwnershipExtra), so the share of any contributor is computed on the main thread. The extra
 * always covers every unit with history, whatever subset of values this patch carries.
 */
export function ownershipValues(agg: UnitHistory): Float64Array {
  const out = Float64Array.from(agg.commits);
  for (let u = 0; u < out.length; u++) if (agg.offsets[u + 1] === agg.offsets[u]) out[u] = NaN;
  return out;
}
export function ownershipExtraOf(agg: UnitHistory, input: HistoryInput): OwnershipExtra {
  const unitIds: string[] = [], offsets: number[] = [0];
  for (let u = 0; u < agg.units.unitIds.length; u++) {
    if (agg.offsets[u + 1] === agg.offsets[u]) continue;
    unitIds.push(agg.units.unitIds[u]);
    offsets.push(agg.offsets[u + 1]);
  }
  return {
    unitIds, offsets, authorIds: agg.authorIds, authorCommits: agg.authorCommits,
    contributors: input.contributors.map((c) => ({ id: c.id, name: c.name, commits: c.commits })).sort((a, b) => b.commits - a.commits || a.id - b.id),
  };
}
export function ownershipLayer(agg: UnitHistory, input: HistoryInput, prev?: Float64Array, values = ownershipValues(agg)): LayerPatch {
  return {
    op: 'layer', id: 'ownership', def: LAYER_DEFS.ownership,
    ...changed(agg.units, values, prev),
    status: walkStatus(input), coverage: input.complete ? 1 : input.coverage,
    extra: ownershipExtraOf(agg, input),
  };
}

/**
 * All three history layers as `layer` operations ready for store.propose. Pass the previous call's
 * `state` to get only the values that changed since (the unit list must be the same; otherwise
 * everything is sent again).
 */
export function historyLayers(
  input: HistoryInput, source: StructureSource, cfg: Config = defaultConfig, prev?: HistoryLayerState,
): { ops: LayerPatch[]; state: HistoryLayerState } {
  const agg = aggregateHistory(input, source);
  const ids = agg.units.unitIds;
  const p = prev && prev.unitIds.length === ids.length && (prev.unitIds === ids || prev.unitIds.every((id, i) => id === ids[i])) ? prev : undefined;
  const state: HistoryLayerState = {
    unitIds: ids,
    recency: recencyValues(agg, input),
    knowledgeRisk: knowledgeRiskValues(agg, cfg.overlays.knowledgeRisk.minCommits),
    ownership: ownershipValues(agg),
  };
  return {
    ops: [
      recencyLayer(agg, input, p?.recency, state.recency),
      knowledgeRiskLayer(agg, input, cfg, p?.knowledgeRisk, state.knowledgeRisk),
      ownershipLayer(agg, input, p?.ownership, state.ownership),
    ],
    state,
  };
}
