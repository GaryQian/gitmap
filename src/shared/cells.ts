// District territories: the Voronoi diagram of a city's district centres, clipped to the city's
// outline (PLAN.md §7.1 "Voronoi districts", §8.2). One definition shared by physics (containment)
// and the renderer (borders). Coordinates are local to the city centre.
import { Delaunay } from 'd3-delaunay';

export interface CellSite { x: number; z: number }
/** A convex polygon as a flat [x0, z0, x1, z1, …] ring (not closed), counter-clockwise or clockwise as produced. */
export type Cell = number[];

const CIRCLE_SIDES = 40;

/** Clip a convex polygon to the half-plane left of the directed line a → b (Sutherland–Hodgman step). */
function clipHalfPlane(poly: number[], ax: number, az: number, bx: number, bz: number): number[] {
  const out: number[] = [];
  const n = poly.length / 2;
  const side = (x: number, z: number) => (bx - ax) * (z - az) - (bz - az) * (x - ax);
  for (let i = 0; i < n; i++) {
    const x1 = poly[2 * i], z1 = poly[2 * i + 1];
    const x2 = poly[2 * ((i + 1) % n)], z2 = poly[2 * ((i + 1) % n) + 1];
    const s1 = side(x1, z1), s2 = side(x2, z2);
    if (s1 >= 0) out.push(x1, z1);
    if ((s1 >= 0) !== (s2 >= 0)) {
      const t = s1 / (s1 - s2);
      out.push(x1 + (x2 - x1) * t, z1 + (z2 - z1) * t);
    }
  }
  return out;
}

/**
 * One cell per site, in site order: its Voronoi cell clipped to a circle of radius `cityRadius`
 * around the origin. A single site gets the whole circle. A degenerate cell comes back empty.
 */
export function districtCells(sites: readonly CellSite[], cityRadius: number): Cell[] {
  const circle: number[] = [];
  for (let i = 0; i < CIRCLE_SIDES; i++) {
    const a = (i / CIRCLE_SIDES) * 2 * Math.PI;
    circle.push(cityRadius * Math.cos(a), cityRadius * Math.sin(a));
  }
  if (sites.length === 0) return [];
  if (sites.length === 1) return [circle];
  const flat = new Float64Array(sites.length * 2);
  sites.forEach((s, i) => { flat[2 * i] = s.x; flat[2 * i + 1] = s.z; });
  const r = cityRadius * 1.01;
  const voronoi = new Delaunay(flat).voronoi([-r, -r, r, r]);
  const cells: Cell[] = [];
  for (let i = 0; i < sites.length; i++) {
    const ring = voronoi.cellPolygon(i);
    if (!ring) { cells.push([]); continue; }
    let poly: number[] = [];
    for (let k = 0; k < ring.length - 1; k++) poly.push(ring[k][0], ring[k][1]);
    // clip against each side of the circle polygon (counter-clockwise, so inside is to the left)
    for (let k = 0; k < CIRCLE_SIDES && poly.length >= 6; k++) {
      const j = (k + 1) % CIRCLE_SIDES;
      poly = clipHalfPlane(poly, circle[2 * k], circle[2 * k + 1], circle[2 * j], circle[2 * j + 1]);
    }
    cells.push(poly.length >= 6 ? poly : []);
  }
  return cells;
}

/** True when (x, z) lies inside a convex cell (either winding). */
export function pointInCell(cell: Cell, x: number, z: number): boolean {
  const n = cell.length / 2;
  if (n < 3) return false;
  let sign = 0;
  for (let i = 0; i < n; i++) {
    const x1 = cell[2 * i], z1 = cell[2 * i + 1];
    const x2 = cell[2 * ((i + 1) % n)], z2 = cell[2 * ((i + 1) % n) + 1];
    const cross = (x2 - x1) * (z - z1) - (z2 - z1) * (x - x1);
    if (cross !== 0) {
      const s = cross > 0 ? 1 : -1;
      if (sign === 0) sign = s; else if (s !== sign) return false;
    }
  }
  return true;
}

/** Area-weighted centroid of a cell, or null for an empty one. */
export function cellCentroid(cell: Cell): { x: number; z: number; area: number } | null {
  const n = cell.length / 2;
  if (n < 3) return null;
  let a = 0, cx = 0, cz = 0;
  for (let i = 0; i < n; i++) {
    const x1 = cell[2 * i], z1 = cell[2 * i + 1];
    const x2 = cell[2 * ((i + 1) % n)], z2 = cell[2 * ((i + 1) % n) + 1];
    const w = x1 * z2 - x2 * z1;
    a += w; cx += (x1 + x2) * w; cz += (z1 + z2) * w;
  }
  if (Math.abs(a) < 1e-12) return null;
  return { x: cx / (3 * a), z: cz / (3 * a), area: Math.abs(a) / 2 };
}
