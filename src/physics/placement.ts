// Where a new node starts. d3 would put a node without x/y on a phyllotaxis spiral by array index,
// far from its district for a late index (PLAN.md §7.2), so every node gets an explicit position
// before it reaches a simulation: beside an already-placed linked neighbour, else near its parent's
// centre with a small seeded jitter. The jitter depends only on (seed, id), never on arrival order.
import { hash32, mulberry32 } from '../shared';
import { cellReach, type LocalCell } from './cells';
import type { CityTier } from './cityTier';
import type { DistrictSim } from './districtTier';
import type { FileSim } from './fileTier';
import type { PLink, PNode } from './sim';
import type { Tuning } from './tuning';

const TAU = Math.PI * 2;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

function rngFor(seed: number, salt: number, id: string): () => number {
  return mulberry32((seed + salt + hash32(id)) >>> 0);
}

/** For each unplaced node, one already-placed node it is linked to (the first by link order). */
function placedNeighbours(links: readonly PLink[]): Map<PNode, PNode> {
  const out = new Map<PNode, PNode>();
  for (const l of links) {
    const a = l.source, b = l.target;
    if (!a.placed && b.placed) { if (!out.has(a)) out.set(a, b); }
    else if (!b.placed && a.placed) { if (!out.has(b)) out.set(b, a); }
  }
  return out;
}

function put(n: PNode, x: number, y: number): void {
  n.x = x; n.y = y; n.vx = 0; n.vy = 0;
}

/** Pull a point back inside a disc of radius `lim` around the origin. */
function clampInto(n: PNode, lim: number): void {
  const d = Math.sqrt(n.x * n.x + n.y * n.y);
  if (d > lim && d > 0) { n.x *= lim / d; n.y *= lim / d; }
}

/**
 * Cities. A first layout scatters them over a disc sized for their radii; a later arrival goes beside
 * a linked city, else just outside the current map, so it does not land on top of settled cities.
 */
export function placeCities(tier: CityTier, adds: readonly PNode[], seed: number, t: Tuning): void {
  if (!adds.length) return;
  const placed = tier.nodes.filter((n) => n.placed);
  if (!placed.length) {
    let sum = 0;
    for (const n of tier.nodes) sum += n.r;
    const spread = Math.sqrt(tier.nodes.length) * 2 * (sum / tier.nodes.length);
    for (const n of adds) {
      const rnd = rngFor(seed, 1, n.id);
      const a = rnd() * TAU, rr = Math.sqrt(rnd()) * spread * 0.5;
      put(n, Math.cos(a) * rr, Math.sin(a) * rr);
    }
  } else {
    const neighbour = placedNeighbours(tier.links);
    let cx = 0, cy = 0;
    for (const n of placed) { cx += n.x; cy += n.y; }
    cx /= placed.length; cy /= placed.length;
    let extent = 0;
    for (const n of placed) extent = Math.max(extent, Math.sqrt((n.x - cx) * (n.x - cx) + (n.y - cy) * (n.y - cy)) + n.r);
    for (const n of adds) {
      const rnd = rngFor(seed, 1, n.id);
      const a = rnd() * TAU;
      const m = neighbour.get(n);
      if (m) { const dist = m.r + n.r + t.city.gap; put(n, m.x + Math.cos(a) * dist, m.y + Math.sin(a) * dist); }
      else { const dist = extent + n.r + t.city.gap; put(n, cx + Math.cos(a) * dist, cy + Math.sin(a) * dist); }
    }
  }
  for (const n of adds) n.placed = true;
}

/** Districts, local to their city: beside a linked district, else scattered around the city centre. */
export function placeDistricts(ds: DistrictSim, adds: readonly PNode[], seed: number, t: Tuning): void {
  if (!adds.length) return;
  const neighbour = ds.nodes.some((n) => n.placed) ? placedNeighbours(ds.links) : null;
  for (const n of adds) {
    const rnd = rngFor(seed, 2, n.id);
    const a = rnd() * TAU;
    const m = neighbour?.get(n);
    if (m) {
      const dist = m.r + n.r + t.district.pad;
      put(n, m.x + Math.cos(a) * dist, m.y + Math.sin(a) * dist);
      clampInto(n, Math.max(0, ds.containR - n.r));
    } else {
      const rr = Math.sqrt(rnd()) * ds.containR * 0.6;
      put(n, Math.cos(a) * rr, Math.sin(a) * rr);
    }
  }
  for (const n of adds) n.placed = true;
}

/** A unit's own place in its territory on the bearing `a`: its share (n.target) of the way to the edge. */
function toPlace(n: PNode, a: number, fs: FileSim, cell: LocalCell | undefined): void {
  const ux = Math.cos(a), uy = Math.sin(a);
  const ox = cell ? cell.cx : 0, oy = cell ? cell.cy : 0;
  const reach = cell ? cellReach(cell, ux, uy) : fs.containR;
  const d = n.target * Math.max(0, reach - n.r);
  put(n, ox + ux * d, oy + uy * d);
}

/**
 * Units, local to their district. A first layout puts every unit at its own place on a golden-angle
 * spiral: near-packed and near equilibrium, which settled fastest and cleanest in the spike. A later
 * arrival goes beside a linked unit, else to its own place on a seeded bearing.
 * `ranked` is the district's units in rank order (rankTargets), with targets already set.
 */
export function placeUnits(fs: FileSim, adds: readonly PNode[], ranked: readonly PNode[], seed: number, t: Tuning, cell?: LocalCell): void {
  if (!adds.length) return;
  if (!fs.nodes.some((n) => n.placed)) {
    spiralUnits(fs, ranked, seed, cell);
  } else {
    const neighbour = placedNeighbours(fs.links);
    for (const n of adds) {
      const rnd = rngFor(seed, 3, n.id);
      const a = rnd() * TAU;
      const m = neighbour.get(n);
      if (m) {
        const dist = m.r + n.r + t.file.pad + rnd() * t.file.gap;
        put(n, m.x + Math.cos(a) * dist, m.y + Math.sin(a) * dist);
        if (!cell) clampInto(n, Math.max(0, fs.containR - n.r));
      } else toPlace(n, a, fs, cell);
    }
  }
  for (const n of adds) n.placed = true;
}

/** Every unit of a district at its own place on a golden-angle spiral over the territory. */
export function spiralUnits(fs: FileSim, ranked: readonly PNode[], seed: number, cell?: LocalCell): void {
  for (let k = 0; k < ranked.length; k++) {
    const n = ranked[k];
    toPlace(n, k * GOLDEN_ANGLE + rngFor(seed, 3, n.id)() * 0.01, fs, cell);
    n.placed = true;
  }
}
