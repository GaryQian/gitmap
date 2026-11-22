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

// ---- territories as physics lays them out (src/physics/cells.ts) ----
//
// Physics does not use the plain Voronoi cells above. A district's territory is its own reach (a
// 32-sided polygon of radius `bound`) cut by the power-diagram edge toward every sibling, with
// weight = shape.weight · r², where r is the district's content radius: bound = reach · r + pad / 2.
// The edge between two districts then sits between their discs when they touch, instead of halfway
// between their centres. territoryCells reproduces that construction from what the position buffers
// carry (x, z, bound), so drawn borders coincide with where files are contained.

export interface TerritorySite { x: number; z: number; /** Bounding radius of the territory: the `r` of the district's position row. */ bound: number }
export interface TerritoryShape { /** physics.district.reach */ reach: number; /** physics.district.pad */ pad: number; /** physics.district.cellWeight */ weight: number }
export interface TerritoryCell {
  /** The ring as [x0, z0, x1, z1, …], not closed, counter-clockwise, in the sites' coordinates. */
  ring: number[];
  /** Per edge i (from vertex i to i + 1): the index of the sibling whose power edge it lies on, or −1 for the cell's own reach. */
  neighbour: number[];
}

const REACH_SIDES = 32;

/** Keep the part of a tagged convex ring where ax·x + az·z ≤ b; the new edge along the cut gets `tag`. */
function clipTagged(ring: number[], tags: number[], ax: number, az: number, b: number, tag: number): { ring: number[]; tags: number[] } {
  const out: number[] = [], outTags: number[] = [];
  const n = ring.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const x1 = ring[2 * i], z1 = ring[2 * i + 1], x2 = ring[2 * j], z2 = ring[2 * j + 1];
    const s1 = b - (ax * x1 + az * z1), s2 = b - (ax * x2 + az * z2);
    if (s1 >= 0) { out.push(x1, z1); outTags.push(tags[i]); }
    if ((s1 >= 0) !== (s2 >= 0)) {
      const k = s1 / (s1 - s2);
      out.push(x1 + (x2 - x1) * k, z1 + (z2 - z1) * k);
      // leaving the kept side: the next edge runs along the cut; entering it: the rest of this edge
      outTags.push(s1 >= 0 ? tag : tags[i]);
    }
  }
  return { ring: out, tags: outTags };
}

/** One territory per site, in site order; an empty ring for a district wholly covered by its neighbours. */
export function territoryCells(sites: readonly TerritorySite[], shape: TerritoryShape): TerritoryCell[] {
  const n = sites.length;
  const radius = sites.map((s) => Math.max(0, (s.bound - shape.pad / 2) / shape.reach));
  const order = sites.map((_, i) => i);
  const cells: TerritoryCell[] = [];
  for (let i = 0; i < n; i++) {
    const d = sites[i];
    const wi = shape.weight * radius[i] * radius[i];
    order.sort((p, q) => {
      const dp = (sites[p].x - d.x) ** 2 + (sites[p].z - d.z) ** 2, dq = (sites[q].x - d.x) ** 2 + (sites[q].z - d.z) ** 2;
      return dp - dq || p - q;
    });
    let ring: number[] = [], tags: number[] = [];
    for (let v = 0; v < REACH_SIDES; v++) {
      const a = (v / REACH_SIDES) * 2 * Math.PI;
      ring.push(d.x + Math.cos(a) * d.bound, d.z + Math.sin(a) * d.bound);
      tags.push(-1);
    }
    let reach = d.bound;
    for (let k = 0; k < n && ring.length >= 6; k++) {
      const j = order[k];
      if (j === i) continue;
      const o = sites[j];
      const dx = o.x - d.x, dz = o.z - d.z, dist2 = dx * dx + dz * dz;
      if (dist2 < 1e-9) continue;
      const wj = shape.weight * radius[j] * radius[j];
      if ((dist2 + wi - wj) / (2 * Math.sqrt(dist2)) >= reach) continue;
      ({ ring, tags } = clipTagged(ring, tags, 2 * dx, 2 * dz, o.x * o.x + o.z * o.z - d.x * d.x - d.z * d.z + wi - wj, j));
      reach = 0;
      for (let v = 0; v < ring.length; v += 2) reach = Math.max(reach, Math.hypot(ring[v] - d.x, ring[v + 1] - d.z));
    }
    cells.push(ring.length >= 6 ? { ring, neighbour: tags } : { ring: [], neighbour: [] });
  }
  return cells;
}
