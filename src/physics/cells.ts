// District territories (PLAN.md §7.1 "Voronoi districts").
//
// A district's territory is a cell around its disc, and its units are contained in that cell and
// spread over all of it. Two things shape a cell:
//
// 1. Its neighbours. The edge between two districts is the power-diagram edge of their discs (weight
//    r²): it moves from the halfway line toward the smaller district by (rA² − rB²) / 2d, which puts
//    it between the two discs when they touch. A plain Voronoi edge lies halfway between the centres
//    whatever the sizes, so a large district would lose a slice of its room to a small neighbour.
//    Districts that do not overlap each lie wholly inside their own cell.
// 2. Its own reach. A cell ends at n.bound = physics.district.reach · r (+ half the pad) from its
//    centre: far enough to take in the gaps between touching discs, so districts tile the inside of a
//    city, and no further, so a district on the edge of a city bulges a little and the city's outline
//    is the union of its districts' territories, an organic shape and not a circle.
//
// So every cell's area follows its content, whether the district is in the middle or on the edge.
// physics.district.cellWeight scales the weights; at 0 the edges are plain Voronoi edges, as
// districtCells() in src/shared/cells.ts draws them (see "Requested changes" in the 2D report).
//
// Each cell is kept in coordinates local to its district centre, as inward half-planes, which is what
// containing that district's units needs. Cells are recomputed when a district centre or radius has
// changed by more than an epsilon since the last time, not every tick.
import type { PNode } from './sim';

/** One district's cell, local to the district centre. */
export interface LocalCell {
  /** The ring as [x0, y0, x1, y1, …], not closed, counter-clockwise. */
  ring: Float64Array;
  /** Per edge: unit inward normal and offset, so nx·x + ny·y − off is how far inside that edge a point is. */
  nx: Float64Array;
  ny: Float64Array;
  off: Float64Array;
  /** Area-weighted centroid and area. */
  cx: number;
  cy: number;
  area: number;
  /** Radius of the largest circle around the centroid that fits inside: a disc within it crosses no edge. */
  inner: number;
  /** Distance from the centroid to the edge along REACH_STEPS evenly spaced bearings (see cellReach). */
  reach: Float64Array;
}

/** Bearings the reach of a cell is tabulated at. */
const REACH_STEPS = 64;

/** The cells of one city, as of the geometry they were computed from. */
export interface CityCells {
  /** The node array the cells belong to (a membership change replaces it). */
  nodes: readonly PNode[];
  /** District [x, y, r] at the time. */
  at: Float64Array;
  /** Cell centroid [x, y] per node, city-local: the Lloyd target. A missing cell gives the centre itself. */
  centroids: Float64Array;
}

/** Sides of the polygon that stands in for a district's own reach. */
const CIRCLE_SIDES = 32;
const TINY = 1e-9;

/** Keep the part of a convex ring where ax·x + ay·y ≤ b (one Sutherland–Hodgman step). */
function clip(poly: number[], ax: number, ay: number, b: number): number[] {
  const out: number[] = [];
  const n = poly.length / 2;
  for (let i = 0; i < n; i++) {
    const x1 = poly[2 * i], y1 = poly[2 * i + 1];
    const j = (i + 1) % n;
    const x2 = poly[2 * j], y2 = poly[2 * j + 1];
    const s1 = b - (ax * x1 + ay * y1), s2 = b - (ax * x2 + ay * y2);
    if (s1 >= 0) out.push(x1, y1);
    if ((s1 >= 0) !== (s2 >= 0)) {
      const k = s1 / (s1 - s2);
      out.push(x1 + (x2 - x1) * k, y1 + (y2 - y1) * k);
    }
  }
  return out;
}

/** A counter-clockwise city-local ring, moved to a district centre and given its half-planes. */
function toLocalCell(poly: readonly number[], ox: number, oy: number): LocalCell | undefined {
  const n = poly.length / 2;
  if (n < 3) return undefined;
  const ring = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) { ring[2 * i] = poly[2 * i] - ox; ring[2 * i + 1] = poly[2 * i + 1] - oy; }
  let a = 0, cx = 0, cy = 0;
  const nx: number[] = [], ny: number[] = [], off: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const x1 = ring[2 * i], y1 = ring[2 * i + 1], x2 = ring[2 * j], y2 = ring[2 * j + 1];
    const cross = x1 * y2 - x2 * y1;
    a += cross; cx += (x1 + x2) * cross; cy += (y1 + y2) * cross;
    const ex = x2 - x1, ey = y2 - y1, len = Math.sqrt(ex * ex + ey * ey);
    if (len < TINY) continue;
    nx.push(-ey / len); ny.push(ex / len); off.push((-ey * x1 + ex * y1) / len);
  }
  if (a < TINY || nx.length < 3) return undefined;
  const cell: LocalCell = {
    ring, nx: Float64Array.from(nx), ny: Float64Array.from(ny), off: Float64Array.from(off),
    cx: cx / (3 * a), cy: cy / (3 * a), area: a / 2, inner: Infinity, reach: new Float64Array(REACH_STEPS),
  };
  for (let e = 0; e < cell.off.length; e++) {
    cell.inner = Math.min(cell.inner, cell.nx[e] * cell.cx + cell.ny[e] * cell.cy - cell.off[e]);
  }
  for (let k = 0; k < REACH_STEPS; k++) {
    const b = (k / REACH_STEPS) * 2 * Math.PI;
    cell.reach[k] = edgeDistance(cell, cell.cx, cell.cy, Math.cos(b), Math.sin(b));
  }
  return cell;
}

/**
 * True when `prev` still describes these districts: same nodes, and no centre or radius has changed
 * by more than `eps`.
 */
export function cellsCurrent(prev: CityCells | null, nodes: readonly PNode[], eps: number): prev is CityCells {
  if (!prev || prev.nodes !== nodes || prev.at.length !== nodes.length * 3) return false;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (Math.abs(n.x - prev.at[3 * i]) > eps || Math.abs(n.y - prev.at[3 * i + 1]) > eps || Math.abs(n.r - prev.at[3 * i + 2]) > eps) return false;
  }
  return true;
}

/**
 * The cells of one city's districts: for each, its own reach (a polygon of radius n.bound) cut by the
 * power-diagram edge (weight = `weight` · r²) toward every sibling. `into[slot]` receives each
 * district's local cell, or undefined when it has none (a district wholly covered by overlapping
 * neighbours, which collide then pushes apart).
 */
export function computeCells(nodes: readonly PNode[], weight: number, into: (LocalCell | undefined)[]): CityCells {
  const n = nodes.length;
  const at = new Float64Array(3 * n), centroids = new Float64Array(2 * n);
  const unit: number[] = [];
  for (let i = 0; i < CIRCLE_SIDES; i++) {
    const a = (i / CIRCLE_SIDES) * 2 * Math.PI;
    unit.push(Math.cos(a), Math.sin(a));
  }
  const order = nodes.map((_, i) => i);
  for (let i = 0; i < n; i++) {
    const d = nodes[i];
    at[3 * i] = d.x; at[3 * i + 1] = d.y; at[3 * i + 2] = d.r;
    const wi = weight * d.r * d.r;
    // nearest first: the cell shrinks early, and distant districts are then skipped without clipping
    order.sort((p, q) => {
      const dp = (nodes[p].x - d.x) ** 2 + (nodes[p].y - d.y) ** 2, dq = (nodes[q].x - d.x) ** 2 + (nodes[q].y - d.y) ** 2;
      return dp - dq || p - q;
    });
    let poly: number[] = [];
    for (let v = 0; v < unit.length; v += 2) poly.push(d.x + unit[v] * d.bound, d.y + unit[v + 1] * d.bound);
    let reach = d.bound; // no point of the cell is farther from the centre
    for (let k = 0; k < n && poly.length >= 6; k++) {
      const j = order[k];
      if (j === i) continue;
      const o = nodes[j];
      const dx = o.x - d.x, dy = o.y - d.y, dist2 = dx * dx + dy * dy;
      if (dist2 < TINY) continue; // coincident centres: collide separates them
      const wj = weight * o.r * o.r, dist = Math.sqrt(dist2);
      // the edge crosses the line between the centres this far from this centre
      const edge = (dist2 + wi - wj) / (2 * dist);
      if (edge >= reach) continue;
      // inside: |p − d|² − wi ≤ |p − o|² − wj
      poly = clip(poly, 2 * dx, 2 * dy, o.x * o.x + o.y * o.y - d.x * d.x - d.y * d.y + wi - wj);
      reach = 0;
      for (let v = 0; v < poly.length; v += 2) reach = Math.max(reach, Math.sqrt((poly[v] - d.x) ** 2 + (poly[v + 1] - d.y) ** 2));
    }
    const cell = poly.length >= 6 ? toLocalCell(poly, d.x, d.y) : undefined;
    into[d.slot] = cell;
    centroids[2 * i] = d.x + (cell ? cell.cx : 0);
    centroids[2 * i + 1] = d.y + (cell ? cell.cy : 0);
  }
  return { nodes, at, centroids };
}

/** Distance from the point (px, py) to the cell's edge in the unit direction (ux, uy); 0 from outside. */
function edgeDistance(cell: LocalCell, px: number, py: number, ux: number, uy: number): number {
  let reach = Infinity;
  for (let e = 0; e < cell.off.length; e++) {
    const inside = cell.nx[e] * px + cell.ny[e] * py - cell.off[e];
    if (inside <= 0) return 0;
    const closing = -(cell.nx[e] * ux + cell.ny[e] * uy);
    if (closing > TINY) reach = Math.min(reach, inside / closing);
  }
  return reach === Infinity ? 0 : reach;
}

/**
 * How far the cell reaches from its centroid along the bearing of (dx, dy): read from the table, the
 * shorter of the two tabulated bearings either side, so it never overshoots a corner.
 */
export function cellReach(cell: LocalCell, dx: number, dy: number): number {
  let turn = Math.atan2(dy, dx) / (2 * Math.PI);
  if (turn < 0) turn += 1;
  const k = Math.min(REACH_STEPS - 1, Math.floor(turn * REACH_STEPS));
  return Math.min(cell.reach[k], cell.reach[(k + 1) % REACH_STEPS]);
}

/** How far a unit's disc reaches outside its cell: 0 when wholly inside. */
export function strayDepth(n: PNode, cell: LocalCell): number {
  let worst = 0;
  for (let e = 0; e < cell.off.length; e++) {
    const out = n.r - (cell.nx[e] * n.x + cell.ny[e] * n.y - cell.off[e]);
    if (out > worst) worst = out;
  }
  return worst;
}

export function hasStray(nodes: readonly PNode[], cell: LocalCell, tolerance: number): boolean {
  for (const n of nodes) if (strayDepth(n, cell) > tolerance) return true;
  return false;
}

/**
 * Move every unit that reaches outside its cell straight back in, with no regard for its neighbours.
 * The last resort when a capped settle leaves no time to do it with forces: discs first, and where a
 * disc is wider than the cell at that spot, at least its centre. Returns how many units moved.
 */
export function clampIntoCell(nodes: readonly PNode[], cell: LocalCell): number {
  let moved = 0;
  const edges = cell.off.length;
  for (const n of nodes) {
    let touched = false;
    for (const inset of [n.r, n.r, 0, 0]) {
      for (let e = 0; e < edges; e++) {
        const inside = cell.nx[e] * n.x + cell.ny[e] * n.y - cell.off[e] - inset;
        if (inside < 0) { n.x -= cell.nx[e] * inside; n.y -= cell.ny[e] * inside; touched = true; }
      }
    }
    if (touched) { n.vx = 0; n.vy = 0; moved++; }
  }
  return moved;
}
