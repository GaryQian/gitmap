// District tier (PLAN.md §7.1): one simulation per city, in coordinates local to the city centre.
//   forceLink on inter-district weight inside the city · spatial-hash collide (district radius + pad) ·
//   forceContain in the city radius · forceExternalPull toward the outside cities a district depends on.
// Package 2D adds Voronoi cells, cell containment and Lloyd relaxation here.
import { forceLink } from 'd3-force';
import { forceContain, forceExternalPull, forceGridCollide, type ExternalPull } from './forces';
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
}

export function createDistrictSim(city: number, t: Tuning, bearing: (n: PNode) => readonly [number, number]): DistrictSim {
  const ds = { city, nodes: [], links: [], maxW: 1, estimate: 0, containR: 0, contentDirty: true, ticked: -1 } as unknown as DistrictSim;
  ds.link = forceLink<PNode, PLink>([])
    .distance((l) => l.source.r + l.target.r + t.district.pad * (1 + 2 * (1 - l.w / ds.maxW)))
    .strength((l) => t.district.linkStrength / Math.max(1, Math.min(l.source.deg, l.target.deg)));
  ds.collide = forceGridCollide((n) => n.r + t.district.pad / 2);
  ds.external = forceExternalPull(bearing, t.district.externalPull, () => ds.containR * t.externalPullScale);
  ds.sim = makeSim(t)
    .force('link', ds.link)
    .force('collide', ds.collide)
    .force('contain', forceContain(() => ds.containR, t.containStrength))
    .force('external', ds.external);
  return ds;
}

/** The radius a city needs for these districts before they have been laid out. */
export function estimateCityRadius(districts: readonly PNode[], t: Tuning): number {
  return areaRadius(districts, t.district.pad, t.packing);
}
