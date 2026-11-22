// Custom forces. Each follows the d3 contract: a function force(alpha) with initialize(nodes, random)
// (PLAN.md §7.2). Ported from spikes/physics/layout.ts, where they were measured.
import type { Force } from 'd3-force';
import { cellReach, type LocalCell } from './cells';
import type { PLink, PNode } from './sim';

type PForce = Force<PNode, PLink>;

/** A force that acts only while `on()` holds: how a simulation drops to its constraints (collide, contain). */
export function gated(inner: PForce, on: () => boolean): PForce {
  const force: PForce = (alpha) => { if (on()) inner(alpha); };
  force.initialize = (nodes, random) => inner.initialize?.(nodes, random);
  return force;
}

/** Keep each node's disc inside a circle of radius R() centred on the local origin. */
export function forceContain(radius: () => number, strength: number): PForce {
  let nodes: PNode[] = [];
  const force: PForce = () => {
    const R = radius();
    for (const n of nodes) {
      const x = n.x + n.vx, y = n.y + n.vy; // predicted position
      const d = Math.sqrt(x * x + y * y);
      const lim = Math.max(0, R - n.r);
      if (d > lim && d > 0) {
        const k = ((d - lim) / d) * strength;
        n.vx -= x * k;
        n.vy -= y * k;
      }
    }
  };
  force.initialize = (ns) => { nodes = ns; };
  return force;
}

/**
 * Keep each node's disc inside a district's Voronoi cell (PLAN.md §7.1), in coordinates local to the
 * district centre. The cell is convex, so each edge is handled on its own: a disc that crosses an
 * edge is pushed back along that edge's inward normal. Without a cell (before the districts are laid
 * out, or a degenerate cell) the district's disc of radius R() contains instead.
 */
export function forceContainCell(cell: () => LocalCell | undefined, radius: () => number, strength: number): PForce {
  let nodes: PNode[] = [];
  const disc = forceContain(radius, strength);
  const force: PForce = (alpha) => {
    const c = cell();
    if (!c) { disc(alpha); return; }
    const { nx, ny, off, cx, cy, inner } = c, edges = off.length;
    for (const n of nodes) {
      const x = n.x + n.vx, y = n.y + n.vy; // predicted position
      // most units are well inside: within the cell's inner circle no edge can be crossed
      const room = inner - n.r;
      if (room > 0 && (x - cx) * (x - cx) + (y - cy) * (y - cy) <= room * room) continue;
      for (let e = 0; e < edges; e++) {
        const inside = nx[e] * x + ny[e] * y - off[e] - n.r;
        if (inside < 0) {
          n.vx -= nx[e] * inside * strength;
          n.vy -= ny[e] * inside * strength;
        }
      }
    }
  };
  force.initialize = (ns, random) => { nodes = ns; disc.initialize?.(ns, random); };
  return force;
}

/**
 * Size → place (PLAN.md §7.1), shaped to the district's territory. Each unit carries the share of the
 * way from the middle of the territory to its edge at which it belongs (n.target, 0..1: the share of
 * the district's content area that is larger than it, as a radius), and is pulled along its own bearing
 * to that share of the distance to the edge in that direction. So the pull is toward a place, never
 * toward the centre as such: the content is spread over the whole cell, corners included, at an even
 * density, with the largest units tending to the middle. Without a cell the territory is the disc R().
 * `strength` is given alpha and returns the share of the way a unit is moved per tick.
 */
export function forceCellRadial(cell: () => LocalCell | undefined, radius: () => number, strength: (alpha: number) => number): PForce {
  let nodes: PNode[] = [];
  const force: PForce = (alpha) => {
    const c = cell(), R = radius(), k = strength(alpha);
    if (k === 0) return;
    const ox = c ? c.cx : 0, oy = c ? c.cy : 0;
    for (const n of nodes) {
      const dx = n.x + n.vx - ox, dy = n.y + n.vy - oy;
      const d = Math.sqrt(dx * dx + dy * dy);
      const ux = d > 1e-9 ? dx / d : 1, uy = d > 1e-9 ? dy / d : 0;
      const reach = c ? cellReach(c, dx, dy) : R;
      const f = (n.target * Math.max(0, reach - n.r) - d) * k;
      n.vx += ux * f;
      n.vy += uy * f;
    }
  };
  force.initialize = (ns) => { nodes = ns; };
  return force;
}

/**
 * Lloyd relaxation: pull each district toward the centroid of its Voronoi cell, scaled by alpha.
 * `centroids` returns [x, y] per node in node order (city-local), or null when there are no cells.
 */
export function forceLloyd(centroids: () => Float64Array | null, strength: number): PForce {
  let nodes: PNode[] = [];
  const force: PForce = (alpha) => {
    const k = strength * alpha;
    if (k === 0 || nodes.length < 2) return;
    const c = centroids();
    if (!c || c.length !== nodes.length * 2) return;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      n.vx += (c[2 * i] - n.x) * k;
      n.vy += (c[2 * i + 1] - n.y) * k;
    }
  };
  force.initialize = (ns) => { nodes = ns; };
  return force;
}

export interface ExternalPull extends PForce {
  /** Recompute bearings (after cities moved or outside links changed). */
  refresh(): void;
}

/**
 * A constant, alpha-scaled pull along a bearing per node: districts lean toward the outside cities
 * they depend on. `bearing` returns a unit vector, or [0, 0] for no pull.
 */
export function forceExternalPull(bearing: (n: PNode) => readonly [number, number], strength: number, scale: () => number): ExternalPull {
  let nodes: PNode[] = [];
  let dirs: (readonly [number, number])[] = [];
  const force = ((alpha: number) => {
    const k = strength * alpha * scale();
    if (k === 0) return;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i], d = dirs[i];
      n.vx += d[0] * k;
      n.vy += d[1] * k;
    }
  }) as ExternalPull;
  force.refresh = () => { dirs = nodes.map(bearing); };
  force.initialize = (ns) => { nodes = ns; force.refresh(); };
  return force;
}

export interface Collide extends PForce {
  /** Re-read every node's radius (after radii changed without a topology change). */
  refresh(): void;
}
export type GridCollide = Collide;

/**
 * All-pairs collide for the small tiers, where the distance two bodies keep depends on the pair
 * (districts: see districtSpacing). d3 forceCollide's semantics otherwise: one pass, predicted
 * positions, overlap resolved in proportion to radius² so the bigger body moves less.
 */
export function forcePairCollide(spacing: (a: PNode, b: PNode) => number, strength = 1): Collide {
  let nodes: PNode[] = [];
  const force = ((_alpha: number) => {
    const n = nodes.length;
    for (let i = 0; i < n; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < n; j++) {
        const b = nodes[j];
        const r = spacing(a, b);
        let x = a.x + a.vx - b.x - b.vx, y = a.y + a.vy - b.y - b.vy;
        let l = x * x + y * y;
        if (l >= r * r) continue;
        if (x === 0) { x = (i - j) * 1e-6; l += x * x; }
        if (y === 0) { y = (i - j) * 1e-6; l += y * y; }
        l = Math.sqrt(l);
        l = ((r - l) / l) * strength;
        x *= l;
        y *= l;
        const a2 = a.r * a.r, b2 = b.r * b.r, w = a2 + b2 > 0 ? b2 / (a2 + b2) : 0.5;
        a.vx += x * w;
        a.vy += y * w;
        b.vx -= x * (1 - w);
        b.vy -= y * (1 - w);
      }
    }
  }) as Collide;
  force.refresh = () => {};
  force.initialize = (ns) => { nodes = ns; };
  return force;
}

const KEY_OFFSET = 32768;
const KEY_SPAN = 65536;

/**
 * Spatial-hash collide with d3 forceCollide's semantics: one pass, predicted positions, overlap
 * resolved in proportion to radius² so big bodies shove small ones aside. 4.5–6× faster than d3's
 * quadtree collide at 10k–100k nodes (spikes/physics/RESULTS.md).
 * Each node is inserted into every cell its disc touches; a pair is resolved only in the cell that
 * holds the lower-left corner of the intersection of their bounding boxes, so it is visited once.
 */
export function forceGridCollide(radius: (n: PNode) => number, strength = 1): GridCollide {
  let nodes: PNode[] = [];
  let radii = new Float64Array(0);
  let px = new Float64Array(0);
  let py = new Float64Array(0);
  let cell = 1;
  const grid = new Map<number, number[]>();
  const used: number[][] = [];

  const force = ((_alpha: number) => {
    const n = nodes.length;
    if (n < 2) return;
    for (const a of used) a.length = 0;
    used.length = 0;
    const inv = 1 / cell;
    for (let i = 0; i < n; i++) {
      const nd = nodes[i], r = radii[i];
      const x = (px[i] = nd.x + nd.vx), y = (py[i] = nd.y + nd.vy);
      const cx0 = Math.floor((x - r) * inv), cx1 = Math.floor((x + r) * inv);
      const cy0 = Math.floor((y - r) * inv), cy1 = Math.floor((y + r) * inv);
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cy = cy0; cy <= cy1; cy++) {
          const key = (cx + KEY_OFFSET) * KEY_SPAN + (cy + KEY_OFFSET);
          let arr = grid.get(key);
          if (!arr) grid.set(key, (arr = []));
          if (arr.length === 0) used.push(arr);
          arr.push(i);
        }
      }
    }
    for (const [key, arr] of grid) {
      if (arr.length < 2) continue;
      const cx = Math.floor(key / KEY_SPAN) - KEY_OFFSET, cy = (key % KEY_SPAN) - KEY_OFFSET;
      for (let p = 0; p < arr.length; p++) {
        const i = arr[p], ri = radii[i], ni = nodes[i];
        for (let q = p + 1; q < arr.length; q++) {
          const j = arr[q], rj = radii[j];
          const r = ri + rj;
          let x = px[i] - px[j], y = py[i] - py[j];
          // only the owning cell resolves the pair
          const ox = Math.max(px[i] - ri, px[j] - rj), oy = Math.max(py[i] - ri, py[j] - rj);
          if (Math.floor(ox * inv) !== cx || Math.floor(oy * inv) !== cy) continue;
          let l = x * x + y * y;
          if (l >= r * r) continue;
          const nj = nodes[j];
          if (x === 0) { x = (i - j) * 1e-6; l += x * x; }
          if (y === 0) { y = (i - j) * 1e-6; l += y * y; }
          l = Math.sqrt(l);
          l = ((r - l) / l) * strength;
          x *= l;
          y *= l;
          const ri2 = ri * ri, rj2 = rj * rj, w = rj2 / (ri2 + rj2);
          ni.vx += x * w;
          ni.vy += y * w;
          nj.vx -= x * (1 - w);
          nj.vy -= y * (1 - w);
        }
      }
    }
    // drop empty buckets now and then to bound memory
    if (grid.size > 4 * n + 1024) { grid.clear(); used.length = 0; }
  }) as GridCollide;

  force.refresh = () => {
    const n = nodes.length;
    if (radii.length !== n) {
      radii = new Float64Array(n);
      px = new Float64Array(n);
      py = new Float64Array(n);
    }
    for (let i = 0; i < n; i++) radii[i] = radius(nodes[i]);
    // about the p75 diameter: most nodes touch a few cells, big ones span several
    const sorted = radii.slice().sort();
    cell = Math.max(1e-6, 2 * (n ? sorted[Math.floor(n * 0.75)] : 1));
  };
  force.initialize = (ns) => { nodes = ns; force.refresh(); };
  return force;
}

/**
 * Move bodies apart, directly, until no pair is closer than its spacing: the hard form of collide, run
 * once a tier has settled so that a minimum distance holds exactly and not just to within a force's
 * tolerance. The larger body of a pair moves less (radius²). Returns false if it did not converge.
 */
export function separate(nodes: readonly PNode[], spacing: (a: PNode, b: PNode) => number, rounds = 200): boolean {
  for (let round = 0; round < rounds; round++) {
    let moved = false;
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        const want = spacing(a, b);
        let x = a.x - b.x, y = a.y - b.y;
        let l = Math.sqrt(x * x + y * y);
        if (l >= want) continue;
        if (l < 1e-9) { x = 1; y = 0; l = 1; }
        // a hair more than needed, so the next round does not find the same pair short by rounding
        const push = (want - l) * (1 + 1e-9) + 1e-9;
        const a2 = a.r * a.r, b2 = b.r * b.r, share = a2 + b2 > 0 ? b2 / (a2 + b2) : 0.5;
        a.x += (x / l) * push * share;
        a.y += (y / l) * push * share;
        b.x -= (x / l) * push * (1 - share);
        b.y -= (y / l) * push * (1 - share);
        moved = true;
      }
    }
    if (!moved) return true;
  }
  return false;
}
