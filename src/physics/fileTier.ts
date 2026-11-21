// File tier (PLAN.md §7.1): one simulation per district, in coordinates local to the district centre.
//   forceRadial by size rank (largest spheres toward the centre) · forceLink on intra-district edges ·
//   spatial-hash collide (sphere radius + pad) · forceContain in the district radius.
// One knob, physics.file.sizeVsConnectivity = w, balances the two inputs: radial strength is
// 2w · baseStrength and link strength is scaled by 2(1 − w); d3 already divides link strength by
// degree, so equal coefficients give size and connectivity equal pull per node.
import { forceLink, forceRadial } from 'd3-force';
import { forceContain, forceGridCollide } from './forces';
import { areaRadius, makeSim, type PLink, type PNode, type SimParts } from './sim';
import type { Tuning } from './tuning';

export interface FileSim extends SimParts {
  /** District slot this simulation belongs to. */
  district: number;
  /** District radius its units need, from their radii alone (area estimate). Sets the radial targets. */
  estimate: number;
  /** Containment radius: the estimate while content is changing, the measured radius once at rest. */
  containR: number;
  /** Units were added, removed or resized: the district radius must be measured again. */
  contentDirty: boolean;
  /** Scheduler stamp of the last slice that ticked this simulation. */
  ticked: number;
  /** Distance from the camera focus to this district, for scheduling. */
  focusDist: number;
}

export function createFileSim(district: number, t: Tuning): FileSim {
  const fs = { district, nodes: [], links: [], maxW: 1, estimate: 0, containR: 0, contentDirty: true, ticked: -1, focusDist: 0 } as unknown as FileSim;
  const w = t.file.sizeVsConnectivity;
  const linkScale = 2 * (1 - w);
  fs.link = linkScale > 0
    ? forceLink<PNode, PLink>([])
      .distance((l) => l.source.r + l.target.r + t.file.gap / Math.max(l.w, 1e-6))
      .strength((l) => linkScale / Math.max(1, Math.min(l.source.deg, l.target.deg)))
    : null;
  fs.collide = forceGridCollide((n) => n.r + t.file.pad);
  fs.sim = makeSim(t).force('radial', forceRadial<PNode>((n) => n.target, 0, 0).strength(2 * w * t.file.baseStrength));
  if (fs.link) fs.sim.force('link', fs.link);
  fs.sim
    .force('collide', fs.collide)
    .force('contain', forceContain(() => fs.containR, t.containStrength));
  return fs;
}

/** The radius a district needs for these units before they have been laid out. */
export function estimateDistrictRadius(units: readonly PNode[], t: Tuning): number {
  return areaRadius(units, t.file.pad, t.packing) + t.file.pad;
}

/**
 * Set each unit's forceRadial target from its size rank: the largest at the centre, ranks spread
 * area-uniformly out to radialExtent · estimate. Returns the units in rank order.
 * Call before sim.nodes(), which is when forceRadial reads the targets.
 */
export function rankTargets(fs: FileSim, t: Tuning): PNode[] {
  const sorted = fs.nodes.slice().sort((a, b) => b.r - a.r || a.slot - b.slot);
  const reach = fs.estimate * t.radialExtent;
  const n = sorted.length;
  for (let k = 0; k < n; k++) sorted[k].target = Math.sqrt(k / n) * reach;
  return sorted;
}
