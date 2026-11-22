// District tier (PLAN.md §7.1): one simulation per city, in coordinates local to the city centre.
//   forceLink on inter-district weight inside the city · collide · forceContain in the city radius ·
//   forceExternalPull toward the outside cities a district depends on · Lloyd relaxation toward the
//   centroid of the district's cell · weak gravity toward the city centre.
//
// Territories. Districts pack against each other: two discs keep rA + rB + pad between centres, so
// pad is the thin border between two districts and not a moat. The cells (cells.ts) then tile the city,
// each holding its district's disc and its share of the gaps between discs, and each district's units
// spread over the whole of their cell.
//
// While the tier is only making room for a district that grew (constraintsOnly), collide alone acts.
import { forceLink, forceX, forceY } from 'd3-force';
import type { CityCells } from './cells';
import { forceContain, forceExternalPull, forceLloyd, forcePairCollide, gated, type ExternalPull } from './forces';
import { areaRadius, makeSim, type PLink, type PNode, type SimParts } from './sim';
import type { Tuning } from './tuning';

export interface DistrictSim extends SimParts {
  /** City slot this simulation belongs to. */
  city: number;
  external: ExternalPull;
  /** City radius its districts need, from their radii alone (area estimate). */
  estimate: number;
  /** Containment radius: the estimate while content is changing, the measured radius once at rest. */
  containR: number;
  /** A district's radius or membership changed: the city radius must be measured again. */
  contentDirty: boolean;
  /** Scheduler stamp of the last slice that ticked this simulation. */
  ticked: number;
  /** The city's Voronoi cells as last computed, or null before the first time. */
  cells: CityCells | null;
}

export interface DistrictHooks {
  /** Unit vector toward the outside cities a district depends on, or [0, 0]. */
  bearing(n: PNode): readonly [number, number];
  /** Cell centroids per node, brought up to date first; null when there are none. */
  centroids(ds: DistrictSim): Float64Array | null;
}

/** How far a district's territory reaches from its centre: its disc and a share more (see cells.ts). */
export function districtBound(r: number, t: Tuning): number {
  return r * t.district.reach + t.district.pad / 2;
}

/** Centre distance two districts of one city keep: touching, with the pad as a border between them. */
export function districtSpacing(a: PNode, b: PNode, t: Tuning): number {
  return a.r + b.r + t.district.pad;
}

export function createDistrictSim(city: number, t: Tuning, hooks: DistrictHooks): DistrictSim {
  const ds = {
    city, nodes: [], links: [], maxW: 1, estimate: 0, containR: 0, contentDirty: true, ticked: -1,
    constraintsOnly: false, squeeze: false, held: new Set(), budget: 0, cells: null,
  } as unknown as DistrictSim;
  const free = () => !ds.constraintsOnly;
  const pulling = () => !ds.constraintsOnly || ds.squeeze;
  ds.link = forceLink<PNode, PLink>([])
    .distance((l) => districtSpacing(l.source, l.target, t) + 2 * t.district.pad * (1 - l.w / ds.maxW))
    .strength((l) => t.district.linkStrength / Math.max(1, Math.min(l.source.deg, l.target.deg)));
  ds.collide = forcePairCollide((a, b) => districtSpacing(a, b, t));
  ds.external = forceExternalPull(hooks.bearing, t.district.externalPull, () => ds.containR * t.externalPullScale);
  ds.sim = makeSim(t)
    .force('link', gated(ds.link, free))
    .force('collide', ds.collide)
    .force('contain', gated(forceContain(() => ds.containR, t.containStrength), free))
    .force('external', gated(ds.external, free))
    // toward the middle of the city: with collide this is what packs the districts against each other
    .force('x', gated(forceX<PNode>(0).strength(t.district.gravity), pulling))
    .force('y', gated(forceY<PNode>(0).strength(t.district.gravity), pulling));
  if (t.district.lloyd > 0) ds.sim.force('lloyd', gated(forceLloyd(() => hooks.centroids(ds), t.district.lloyd), free));
  return ds;
}

/** The radius a city needs for these districts before they have been laid out. */
export function estimateCityRadius(districts: readonly PNode[], t: Tuning): number {
  return areaRadius(districts, t.district.pad / 2, t.packing);
}

/**
 * Centre of (nearly) the smallest circle enclosing every district's disc, by Bădoiu–Clarkson steps
 * toward the farthest disc. Deterministic; a city's districts are shifted by it before the reveal so
 * the city radius is not inflated by an off-centre arrangement.
 */
export function enclosingCentre(nodes: readonly PNode[]): { x: number; y: number } {
  let cx = 0, cy = 0;
  if (!nodes.length) return { x: 0, y: 0 };
  for (const n of nodes) { cx += n.x; cy += n.y; }
  cx /= nodes.length; cy /= nodes.length;
  for (let k = 1; k <= 64; k++) {
    let far = nodes[0], reach = -1;
    for (const n of nodes) {
      const d = Math.sqrt((n.x - cx) * (n.x - cx) + (n.y - cy) * (n.y - cy)) + n.bound;
      if (d > reach) { reach = d; far = n; }
    }
    const dx = far.x - cx, dy = far.y - cy, d = Math.sqrt(dx * dx + dy * dy);
    if (d < 1e-9) break;
    // step toward the far side of the farthest disc
    const f = (d + far.bound) / d / (k + 1);
    cx += dx * f;
    cy += dy * f;
  }
  return { x: cx, y: cy };
}
