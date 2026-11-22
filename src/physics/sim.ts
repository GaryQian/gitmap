// Node, link and simulation types shared by the three tiers, and the rules for driving d3-force by
// hand (PLAN.md §7.2): every simulation is stopped at construction and ticked by our scheduler.
import { forceSimulation, type ForceLink, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force';
import type { Collide } from './forces';
import type { Tuning } from './tuning';

/** One body in one simulation: a city (world), a district (city-local) or a unit (district-local). */
export interface PNode extends SimulationNodeDatum {
  slot: number;
  id: string;
  /** Slot of the owner: the district of a unit, the city of a district, −1 for a city or an unassigned unit. */
  parent: number;
  /** Collision radius before padding: sphere radius for a unit, territory radius for a district or city. */
  r: number;
  /**
   * District: the radius that bounds its territory, which is what the position buffers carry. `r` is
   * the disc its content packs into and the district's weight among its siblings; the territory is a
   * cell around that disc and reaches a little further (cells.ts). Equal to `r` for cities and units.
   */
  bound: number;
  /** District or city: the radius its content asks for. `r` eases toward it after the reveal (PLAN.md §7.1). */
  rGoal: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** False until the node has been given an explicit position (never d3's phyllotaxis default). */
  placed: boolean;
  /** City: r has been measured from its settled districts (before that it is an area estimate). */
  measured: boolean;
  /** Link degree inside its simulation, recounted whenever the simulation's links are rebuilt. */
  deg: number;
  /** Unit only: forceRadial target distance from the district centre. */
  target: number;
  /** Home position for Reset view. Units have one too, for the rare case a moved cell edge pushed them. */
  hx: number;
  hy: number;
  hasHome: boolean;
}

export interface PLink extends SimulationLinkDatum<PNode> {
  source: PNode;
  target: PNode;
  w: number;
}

export type Sim = Simulation<PNode, PLink>;

/** What every tier's simulation has in common. */
export interface SimParts {
  sim: Sim;
  /** Sorted by slot. */
  nodes: PNode[];
  links: PLink[];
  /** Largest link weight, at least 1. */
  maxW: number;
  /** Null when the tier's link strength is zero and the force is left out. */
  link: ForceLink<PNode, PLink> | null;
  collide: Collide;
  /** Only the constraints act (collide, containment): every other force of the tier is gated off. */
  constraintsOnly: boolean;
  /** With constraintsOnly, during the settle: the tier's pull toward its middle acts too, to close gaps. */
  squeeze: boolean;
  /**
   * City and district tiers, during an update: nodes the batch did not touch, pinned with fx/fy until
   * the simulation is back at rest or something is pushed into them (IMPLEMENTATION.md §4).
   */
  held: Set<PNode>;
  /** Ticks left that a constraints-only run may keep itself awake for, so it always ends. */
  budget: number;
}

export function newNode(slot: number, id: string, parent: number, r: number): PNode {
  return {
    slot, id, parent, r, bound: r, rGoal: r, x: 0, y: 0, vx: 0, vy: 0,
    placed: false, measured: false, deg: 0, target: 0, hx: 0, hy: 0, hasHome: false,
  };
}

/** A simulation we own the clock of: d3's timer is stopped before it can fire. */
export function makeSim(t: Tuning): Sim {
  const sim = forceSimulation<PNode, PLink>([])
    .velocityDecay(t.velocityDecay)
    .alphaDecay(t.alphaDecay)
    .alphaMin(t.alphaMin);
  sim.stop();
  return sim;
}

/**
 * A manual tick() never checks alphaMin, so the scheduler owns sleeping. A dragged simulation holds
 * alphaTarget up while its alpha may still be below alphaMin, so both count (M0 finding).
 */
export function isHot(sim: Sim): boolean {
  const min = sim.alphaMin();
  return sim.alpha() >= min || sim.alphaTarget() >= min;
}

export function reheat(sim: Sim, alpha: number): void {
  if (sim.alpha() < alpha) sim.alpha(alpha);
}

export function sleep(sim: Sim): void {
  sim.alpha(0);
  sim.alphaTarget(0);
}

/**
 * Heat a simulation to `alpha` so that it cools to rest in `ticks` ticks. alphaDecay belongs to
 * whoever heated the simulation last: the pre-reveal settle and a drag cool over physics.settleTicks,
 * an update over the shorter physics.updateTicks.
 */
export function heatFor(sim: Sim, alpha: number, ticks: number): void {
  sim.alphaDecay(1 - Math.pow(Math.min(1, sim.alphaMin() / alpha), 1 / Math.max(1, ticks)));
  sim.alpha(alpha);
}

/**
 * Keep a simulation awake for `ticks` more ticks. For a simulation running on its constraints only,
 * where alpha scales no force and is just the countdown to sleep.
 */
export function countdown(sim: Sim, ticks: number): void {
  heatFor(sim, 1, ticks);
}

/** Fastest node, squared. Zero exactly when no constraint is violated and nothing else acts. */
export function maxSpeed2(nodes: readonly PNode[]): number {
  let m = 0;
  for (const n of nodes) {
    if (n.fx != null) continue;
    const v = n.vx * n.vx + n.vy * n.vy;
    if (v > m) m = v;
  }
  return m;
}

/** Replace a simulation's link list and recount degrees. The link force is told by applyTopology. */
export function setLinks(p: SimParts, links: PLink[]): void {
  p.links = links;
  let maxW = 1;
  for (const n of p.nodes) n.deg = 0;
  for (const l of links) {
    l.source.deg++;
    l.target.deg++;
    if (l.w > maxW) maxW = l.w;
  }
  p.maxW = maxW;
}

/**
 * Hand changed nodes and links to d3: at most one nodes() and one links() call per simulation per
 * batch. nodes() re-initialises every force; links() re-reads degrees, strengths and distances.
 */
export function applyTopology(p: SimParts, nodesChanged: boolean, linksChanged: boolean): void {
  if (nodesChanged) p.sim.nodes(p.nodes);
  if (linksChanged && p.link) p.link.links(p.links);
}

/** Node radii changed without a topology change: re-read collide radii and link rest lengths. */
export function refreshRadii(p: SimParts): void {
  p.collide.refresh();
  if (p.link) p.link.distance(p.link.distance());
}

/** Largest distance from the local origin to the far edge of any node's bounding disc. */
export function enclosingRadius(nodes: readonly PNode[]): number {
  let max = 0;
  for (const n of nodes) {
    const d = Math.sqrt(n.x * n.x + n.y * n.y) + n.bound;
    if (d > max) max = d;
  }
  return max;
}

/** Radius of a disc whose area fits the padded discs of `nodes` at the configured packing share. */
export function areaRadius(nodes: readonly PNode[], pad: number, packing: number): number {
  let a = 0;
  for (const n of nodes) a += (n.r + pad) * (n.r + pad);
  return Math.sqrt(a / packing);
}
