// Layer (or on-demand array) → OverlayView: what RenderApi.setOverlay takes (PLAN.md §10, §17.3).
// Pure. Switching overlays calls this and nothing else: no layer is recomputed.
import { config, type Config, type ThemeMode } from '../config';
import type { ColorStop, OverlayView } from '../contracts/render';
import type { ModelReplica } from '../contracts/store';
import { parseRef, type Layer, type LayerStatus, type NodeRef } from '../model/types';
import { buildAdjacency, computeReach, type Adjacency, type ReachDirection } from './adjacency';
import { OVERLAY_COLORS, OVERLAY_RAMP, fadedColor, fadedToBright, hotToFaded, ownershipStops, ownershipT, unknownColor, type OverlayPalette } from './colors';
import { ownershipContributors, ownershipShare } from './ownership';
import { RECENCY_OLDER, type OverlayId } from './types';

export interface OverlayContext {
  replica: ModelReplica;
  mode: ThemeMode;
  /** Theme tokens; default config.theme. */
  theme?: Config['theme'];
  /** The layer to draw; default `replica.layers.get(id)`. Absent or pending: everything is "not yet known". */
  layer?: Layer | null;
  /** Ownership: whose share to show. Default: the contributor with the most commits. */
  contributorId?: number;
  /** Ownership: a share array already computed with ownershipShare(). */
  share?: Float32Array;
  /** Reach: hop counts already computed with computeReach(). */
  reach?: Float32Array;
  /** Reach: otherwise the seeds (unit or file refs, or unit slots) and the direction to walk from them. */
  seeds?: readonly NodeRef[] | readonly number[];
  direction?: ReachDirection;
  /** Reach: a cached buildAdjacency() result; built here when absent. */
  adjacency?: Adjacency;
  maxHops?: number;
  /** Recency: the present, in seconds. Default: the clock. */
  now?: number;
  /** Bright-end colours per mode; default OVERLAY_COLORS. */
  colors?: Record<ThemeMode, OverlayPalette>;
}

/** An OverlayView plus what the overlay UI shows beside it. Pass it to RenderApi.setOverlay as it is. */
export interface OverlayViewInfo extends OverlayView {
  id: OverlayId;
  status: LayerStatus;
  /** 0..1, for the progress ring. */
  coverage: number;
  /** Ownership: the contributor whose share is shown, for the hover line. */
  contributor?: string;
  labels: {
    /** What t = 0 and t = 1 mean. */
    low: string;
    high: string;
    /** What the neutral "not yet known" style means here. */
    unknown: string;
    /** Discrete overlays: one label per stop, in stop order. */
    categories?: string[];
  };
}

export interface OverlayLegend {
  id: string;
  label: string;
  discrete: boolean;
  /** Sorted by t, as in the view. */
  stops: ColorStop[];
  /** End labels for t = 0 and t = 1. */
  low: string;
  high: string;
  /** Discrete overlays: one swatch per stop. Empty for ramps. */
  categories: { color: string; label: string }[];
  unknown: { color: string; label: string };
  status?: LayerStatus;
  coverage?: number;
}

const DAY = 86400;

/** "3 days", "5 months", "2 years": coarse on purpose, for a legend end label. */
export function formatAge(seconds: number): string {
  const days = seconds / DAY;
  const say = (n: number, unit: string) => { const r = Math.max(1, Math.round(n)); return `${r} ${unit}${r === 1 ? '' : 's'}`; };
  if (days < 1.5) return days < 1 / 24 ? 'under an hour' : days < 1 ? say(days * 24, 'hour') : '1 day';
  if (days < 60) return say(days, 'day');
  if (days < 720) return say(days / 30.44, 'month');
  return say(days / 365.25, 'year');
}

/** "now", or "3 days ago". */
function ago(seconds: number): string {
  return seconds <= OVERLAY_RAMP.recencyNowSlackSeconds ? 'now' : `${formatAge(seconds)} ago`;
}

const hopsText = (n: number): string => `${n} ${n === 1 ? 'hop' : 'hops'}`;

/**
 * One line about a unit under the active overlay, for the hover tooltip: the statistic the overlay
 * colours by (age, hops from the selection, a contributor's share, the top author's share, the test
 * category), or why it is not known. Null when the overlay has nothing to add.
 */
export function overlayFact(view: OverlayViewInfo, replica: ModelReplica, slot: number, now: number = Date.now() / 1000): string | null {
  if (view.id === 'recency') {
    const v = replica.layers.get('recency')?.values[slot];
    if (v === undefined || v !== v) return 'Age not yet known';
    if (v <= RECENCY_OLDER) return 'Last changed before the history walked';
    return `Last changed ${ago(now - v)}`;
  }
  if (view.id === 'reach') {
    const h = view.values[slot];
    if (h === undefined || h !== h) return view.labels.unknown;
    return h === 0 ? 'In the selection' : `${hopsText(h)} from the selection`;
  }
  const v = view.values[slot];
  if (v === undefined || v !== v) return view.labels.unknown;
  const pct = (share: number) => `${Math.round(Math.min(1, Math.max(0, share)) * 100)}%`;
  if (view.id === 'ownership') {
    // undo ownershipT: the floor stands for "any share at all"
    const floor = OVERLAY_RAMP.ownershipFloorT;
    const share = v > 0 ? (v - floor) / (1 - floor) : 0;
    const who = view.contributor ?? 'them';
    return share > 0 ? `${share < 0.005 ? 'Under 1%' : pct(share)} of commits by ${who}` : `No commits by ${who}`;
  }
  if (view.id === 'knowledgeRisk') return `Top author made ${pct(v)} of commits`;
  if (view.id === 'tests') return view.labels.categories?.[Math.round(v)] ?? null;
  return null;
}

function seedSlots(seeds: readonly NodeRef[] | readonly number[], replica: ModelReplica): number[] {
  const out: number[] = [];
  for (const seed of seeds) {
    if (typeof seed === 'number') { out.push(seed); continue; }
    const { kind, id } = parseRef(seed);
    if (kind === 'unit') out.push(replica.table('unit').slotOf(id));
    else if (kind === 'file') {
      const files = replica.table('file');
      const f = files.slotOf(id);
      if (f >= 0) out.push(files.refSlots.unit[f] ?? -1);
    }
  }
  return out.filter((s) => s >= 0);
}

/** Layer values padded or cut to one per unit slot (a fresh array; NaN where there is no value). */
function perSlot(values: Float32Array | undefined, capacity: number): Float32Array {
  const out = new Float32Array(capacity).fill(NaN);
  if (values) out.set(values.length > capacity ? values.subarray(0, capacity) : values);
  return out;
}

/** The view of one overlay, ready for RenderApi.setOverlay. */
export function overlayView(id: OverlayId, ctx: OverlayContext): OverlayViewInfo {
  const { replica, mode } = ctx;
  const tokens = (ctx.theme ?? config.theme)[mode];
  const palette = (ctx.colors ?? OVERLAY_COLORS)[mode];
  const faded = fadedColor(tokens), unknown = unknownColor(tokens);
  const capacity = replica.table('unit').capacity;
  const layer = id === 'reach' ? null : ctx.layer === undefined ? replica.layers.get(id) ?? null : ctx.layer;
  const status: LayerStatus = layer?.status ?? 'pending';
  const coverage = layer?.coverage ?? 0;
  const notYet = 'Not yet known';

  switch (id) {
    case 'recency': {
      const values = perSlot(layer?.values, capacity);
      const now = ctx.now ?? Date.now() / 1000;
      // No fixed scale: the newest file on the map is the bright end and the oldest the faded end,
      // so a dormant repo or an old demo still spans the whole ramp.
      let newest = -Infinity, oldest = Infinity;
      for (const v of values) {
        if (!(v > RECENCY_OLDER)) continue;
        if (v > newest) newest = v;
        if (v < oldest) oldest = v;
      }
      // Log of the age behind the newest file: the first hours and days take most of the ramp, so
      // brightness falls off fast and the old bulk of the repo sits together near the faded end.
      const unit = OVERLAY_RAMP.recencyLogUnitSeconds;
      const span = Math.log1p(Math.max(0, newest - oldest) / unit);
      for (let s = 0; s < capacity; s++) {
        const v = values[s];
        if (v !== v) continue;
        if (v <= RECENCY_OLDER) { values[s] = 0; continue; }
        const t = span > 0 ? 1 - Math.log1p(Math.max(0, newest - v) / unit) / span : 1;
        values[s] = t < 0 ? 0 : t > 1 ? 1 : t;
      }
      const known = newest !== -Infinity;
      return {
        id, values, domain: [0, 1], stops: fadedToBright(faded, palette.recency), unknown, status, coverage,
        labels: {
          low: known ? `Oldest, ${ago(now - oldest)}` : 'Oldest',
          high: known ? `Newest, ${ago(now - newest)}` : 'Newest',
          unknown: notYet,
        },
      };
    }
    case 'ownership': {
      const contributors = ownershipContributors(layer);
      const who = ctx.contributorId ?? contributors[0]?.id;
      const values = ctx.share ? perSlot(ctx.share, capacity) : who === undefined ? perSlot(undefined, capacity) : ownershipShare(layer, who, replica);
      // none stays grey; any share at all is clearly purple, rising to full purple (and glow) at all
      for (let s = 0; s < capacity; s++) values[s] = ownershipT(values[s]);
      const name = contributors.find((c) => c.id === who)?.name;
      return {
        id, values, domain: [0, 1], stops: ownershipStops(faded, palette.ownership), unknown, status, coverage, contributor: name,
        labels: { low: name ? `None by ${name}` : 'None', high: name ? `All by ${name}` : 'All', unknown: status === 'complete' ? 'No history' : notYet },
      };
    }
    case 'knowledgeRisk': {
      const min = config.overlays.knowledgeRisk.minCommits;
      return {
        id, values: perSlot(layer?.values, capacity), domain: [OVERLAY_RAMP.knowledgeRiskFrom, 1],
        stops: fadedToBright(faded, palette.knowledgeRisk), unknown, status, coverage,
        labels: { low: 'Shared', high: 'One author', unknown: status === 'complete' ? `Fewer than ${min} commits` : notYet },
      };
    }
    case 'tests': {
      const t = palette.tests;
      return {
        id, values: perSlot(layer?.values, capacity), domain: [0, 2], discrete: true,
        stops: [{ t: 0, color: t.test }, { t: 0.5, color: t.covered }, { t: 1, color: t.uncovered }],
        unknown, status, coverage,
        labels: { low: 'Tests', high: 'Untested', unknown: layer ? 'Not code' : notYet, categories: ['Tests', 'Referenced by a test', 'Not referenced by any test'] },
      };
    }
    case 'reach': {
      const direction = ctx.direction ?? 'dependsOn';
      const maxHops = ctx.maxHops ?? Infinity;
      const hops = ctx.reach
        ? perSlot(ctx.reach, capacity)
        : computeReach(ctx.adjacency ?? buildAdjacency(replica), seedSlots(ctx.seeds ?? [], replica), direction, maxHops);
      let far = 1;
      for (const h of hops) if (h > far) far = h;
      // The ramp ends one step past the farthest unit, so everything reached stands out from the
      // unreached. With no hop limit it never spans more than reachHops, so the first few hops stay
      // clearly apart; a limit set by the viewer is the span itself.
      const end = Number.isFinite(maxHops) ? far + 1 : Math.min(far + 1, OVERLAY_RAMP.reachHops);
      const not = direction === 'dependsOn' ? 'Not a dependency' : 'Not a dependent';
      return {
        id, values: hops, domain: [0, end], stops: hotToFaded(palette.reach, faded), unknown, status: 'complete', coverage: 1,
        labels: {
          low: 'Selection',
          high: far + 1 > end ? `${end}+ hops` : hopsText(far),
          unknown: Number.isFinite(maxHops) ? `${not} within ${hopsText(maxHops)}` : not,
        },
      };
    }
  }
}

/** Selecting it needs: history layers, the unit graph, a selection to start from, a contributor. */
export interface OverlayInfo {
  id: OverlayId;
  label: string;
  needs: { history: boolean; graph: boolean; selection: boolean; contributor: boolean };
  /** The model layer behind it; null when it is computed on demand. */
  layer: string | null;
}

const need = (history: boolean, graph: boolean, selection: boolean, contributor: boolean) => ({ history, graph, selection, contributor });
const KNOWN: Record<OverlayId, OverlayInfo> = {
  recency: { id: 'recency', label: 'Recency', needs: need(true, false, false, false), layer: 'recency' },
  ownership: { id: 'ownership', label: 'Ownership', needs: need(true, false, false, true), layer: 'ownership' },
  reach: { id: 'reach', label: 'Dependency reach', needs: need(false, true, true, false), layer: null },
  knowledgeRisk: { id: 'knowledgeRisk', label: 'Knowledge risk', needs: need(true, false, false, false), layer: 'knowledgeRisk' },
  tests: { id: 'tests', label: 'Tests', needs: need(false, true, false, false), layer: 'tests' },
};

/** The overlays on offer, in the order of config.overlays.enabled. */
export const OVERLAYS: OverlayInfo[] = config.overlays.enabled.filter((id): id is OverlayId => id in KNOWN).map((id) => KNOWN[id]);

/** What the overlay UI shows for a view: the ramp, its end labels and the "unknown" swatch. */
export function legendFor(view: OverlayView | OverlayViewInfo): OverlayLegend {
  const info = view as Partial<OverlayViewInfo>;
  const stops = [...view.stops].sort((a, b) => a.t - b.t);
  const labels = info.labels;
  const discrete = view.discrete === true;
  return {
    id: view.id,
    label: (KNOWN as Record<string, OverlayInfo | undefined>)[view.id]?.label ?? view.id,
    discrete,
    stops,
    low: labels?.low ?? '',
    high: labels?.high ?? '',
    categories: discrete ? stops.map((s, i) => ({ color: s.color, label: labels?.categories?.[i] ?? '' })) : [],
    unknown: { color: view.unknown, label: labels?.unknown ?? 'Not yet known' },
    status: info.status,
    coverage: info.coverage,
  };
}
