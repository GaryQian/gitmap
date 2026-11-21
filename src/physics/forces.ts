// Custom forces. Each follows the d3 contract: a function force(alpha) with initialize(nodes, random)
// (PLAN.md §7.2). Ported from spikes/physics/layout.ts, where they were measured.
import type { Force } from 'd3-force';
import type { PLink, PNode } from './sim';

type PForce = Force<PNode, PLink>;

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

export interface GridCollide extends PForce {
  /** Re-read every node's radius (after radii changed without a topology change). */
  refresh(): void;
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
