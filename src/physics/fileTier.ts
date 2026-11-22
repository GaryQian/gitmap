// File tier (PLAN.md §7.1): one simulation per district, in coordinates local to the district centre.
//   size → place (forceCellRadial: largest spheres toward the middle of the territory) · forceLink on
//   intra-district edges · spatial-hash collide (sphere radius + pad) · containment in the district's cell.
// One knob, physics.file.sizeVsConnectivity = w, balances the two inputs: the size pull has strength
// 2w · baseStrength and link strength is scaled by 2(1 − w); d3 already divides link strength by
// degree, so equal coefficients give size and connectivity equal pull per node.
//
// Even fill. A district's radius is the disc that holds its content at physics.file.fill, and each
// unit's place along the radius is the share of the content area larger than it, so a ring of the
// territory holds the content whose area fits it: big spheres do not stack in the middle and the rim
// is not left to a thin scatter of small ones. Both pulls fade with alpha and collide does not, and
// each run ends on collide and containment alone, so where they disagree collide wins.
import { forceLink } from 'd3-force';
import type { LocalCell } from './cells';
import { forceCellRadial, forceContainCell, forceGridCollide, gated } from './forces';
import { areaRadius, makeSim, type PLink, type PNode, type SimParts } from './sim';
import type { Tuning } from './tuning';

export interface FileSim extends SimParts {
  /** District slot this simulation belongs to. */
  district: number;
  /** The district radius: the disc that holds these units at physics.file.fill. */
  estimate: number;
  /** Radius of the disc that stands in for the territory while the district has no cell yet: the district radius. */
  containR: number;
  /** Scheduler stamp of the last slice that ticked this simulation. */
  ticked: number;
  /** Distance from the camera focus to this district, for scheduling. */
  focusDist: number;
  /** A cell edge has pushed units since home was marked: Reset view eases them back too. */
  strayed: boolean;
  /** Scale of the collide discs (≥ 1): grown until they cover physics.file.pack of the territory. */
  inflate: number;
}

export function createFileSim(district: number, t: Tuning, cell: () => LocalCell | undefined): FileSim {
  const fs = {
    district, nodes: [], links: [], maxW: 1, estimate: 0, containR: 0, ticked: -1, focusDist: 0,
    constraintsOnly: false, squeeze: false, held: new Set(), budget: 0, strayed: false, inflate: 1,
  } as unknown as FileSim;
  const w = t.file.sizeVsConnectivity;
  const linkScale = 2 * (1 - w);
  fs.link = linkScale > 0
    ? forceLink<PNode, PLink>([])
      .distance((l) => l.source.r + l.target.r + t.file.gap / Math.max(l.w, 1e-6))
      .strength((l) => linkScale / Math.max(1, Math.min(l.source.deg, l.target.deg)))
    : null;
  fs.collide = forceGridCollide((n) => (n.r + t.file.pad) * fs.inflate);
  const free = () => !fs.constraintsOnly;
  fs.sim = makeSim(t).force('radial', gated(forceCellRadial(cell, () => fs.containR, 2 * w * t.file.baseStrength), free));
  if (fs.link) fs.sim.force('link', gated(fs.link, free));
  fs.sim
    .force('collide', fs.collide)
    .force('contain', forceContainCell(cell, () => fs.containR, t.containStrength));
  return fs;
}

/**
 * Size the collide discs to the territory: scaled so that together they cover physics.file.pack of
 * its area (the cell, or the district's disc before there is one), and never below their real size.
 * Returns true when the scale changed enough to matter; the caller then refreshes collide.
 */
export function fitInflate(fs: FileSim, cell: LocalCell | undefined, t: Tuning): boolean {
  let discs = 0;
  for (const n of fs.nodes) discs += (n.r + t.file.pad) * (n.r + t.file.pad);
  const area = cell ? cell.area : Math.PI * fs.containR * fs.containR;
  const want = discs > 0 ? Math.max(1, Math.sqrt((t.file.pack * area) / (Math.PI * discs))) : 1;
  if (Math.abs(want - fs.inflate) <= t.radiusEpsRel * fs.inflate) return false;
  fs.inflate = want;
  return true;
}

/** A district's radius: the disc that holds these units' padded discs at physics.file.fill. */
export function estimateDistrictRadius(units: readonly PNode[], t: Tuning): number {
  return areaRadius(units, t.file.pad, t.file.fill);
}

/**
 * Set each unit's place along the radius of its territory (n.target, 0..1) from its size rank: the
 * share of the district's content area taken by larger units, plus half its own, as a radius. Equal
 * steps of area are equal rings of territory, so the density is even from the middle to the edge.
 * Returns the units in rank order.
 */
export function rankTargets(fs: FileSim, t: Tuning): PNode[] {
  const sorted = fs.nodes.slice().sort((a, b) => b.r - a.r || a.slot - b.slot);
  const area = (n: PNode) => (n.r + t.file.pad) * (n.r + t.file.pad);
  let total = 0;
  for (const n of sorted) total += area(n);
  let before = 0;
  for (const n of sorted) {
    const own = area(n);
    n.target = total > 0 ? Math.sqrt((before + own / 2) / total) : 0;
    before += own;
  }
  return sorted;
}
