// Crisp district borders: the edges where two districts' territories meet, from the same cell
// construction physics uses for containment (territoryCells in src/shared/cells.ts), so a drawn
// border is where files actually stop. Pure. Coordinates are local to the city centre.
import { territoryCells, type TerritoryShape, type TerritorySite } from '../../shared/cells';

/**
 * The borders between the districts of one city as a flat [x0, z0, x1, z1, …] list, each border once.
 *
 * Physics' cells end at each district's reach, but the district shapes drawn on the ground spread
 * farther, so a border cut at the reach stops short in the middle of the shape. Each border is the
 * power-diagram edge between two neighbouring districts, so it is carried on along that edge, as long
 * as those two stay the closest districts, to `outer(bound)` around either one. The renderer then cuts
 * it where the drawn shape ends.
 */
export function districtBorders(sites: readonly TerritorySite[], shape: TerritoryShape, outer: (bound: number) => number = (b) => b): number[] {
  if (sites.length < 2) return [];
  const cells = territoryCells(sites, shape);
  const n = sites.length;
  const radius = sites.map((s) => Math.max(0, (s.bound - shape.pad / 2) / shape.reach));
  const weight = radius.map((r) => shape.weight * r * r);
  // neighbouring pairs: districts whose territories share an edge
  const pairs = new Set<number>();
  cells.forEach((cell, i) => { for (const j of cell.neighbour) if (j >= 0 && j !== i) pairs.add(Math.min(i, j) * n + Math.max(i, j)); });

  const out: number[] = [];
  for (const key of pairs) {
    const i = Math.floor(key / n), j = key % n;
    const d = sites[i], o = sites[j];
    // the edge: points p with a·p = b, where the two districts' powers are equal
    const ax = 2 * (o.x - d.x), az = 2 * (o.z - d.z), a2 = ax * ax + az * az;
    if (a2 < 1e-12) continue;
    const b = o.x * o.x + o.z * o.z - d.x * d.x - d.z * d.z + weight[i] - weight[j];
    const al = Math.sqrt(a2), ux = -az / al, uz = ax / al;
    const px = (ax * b) / a2, pz = (az * b) / a2;
    // how far along the edge it stays within `outer` of either district: the union of two intervals
    let lo = Infinity, hi = -Infinity;
    for (const s of [d, o]) {
      const R = outer(s.bound);
      const qx = px - s.x, qz = pz - s.z;
      const half = ux * qx + uz * qz, c = qx * qx + qz * qz - R * R;
      const disc = half * half - c;
      if (disc < 0) continue;
      const root = Math.sqrt(disc);
      lo = Math.min(lo, -half - root);
      hi = Math.max(hi, -half + root);
    }
    // and only where no third district is closer (in power) than these two
    for (let k = 0; k < n && lo < hi; k++) {
      if (k === i || k === j) continue;
      const s = sites[k];
      const kx = 2 * (s.x - d.x), kz = 2 * (s.z - d.z);
      const rhs = s.x * s.x + s.z * s.z - d.x * d.x - d.z * d.z + weight[i] - weight[k] - (kx * px + kz * pz);
      const c = kx * ux + kz * uz;
      if (Math.abs(c) < 1e-12) { if (rhs < 0) hi = lo; continue; }
      if (c > 0) hi = Math.min(hi, rhs / c); else lo = Math.max(lo, rhs / c);
    }
    if (!(hi - lo > 1e-6)) continue;
    out.push(px + ux * lo, pz + uz * lo, px + ux * hi, pz + uz * hi);
  }
  return out;
}
