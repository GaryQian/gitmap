// Crisp district borders: the interior edges of a city's Voronoi cells (src/shared/cells.ts, the
// same cells physics uses for containment). Pure. Coordinates are local to the city centre.
import { districtCells, type CellSite } from '../../shared/cells';

/**
 * The borders between the districts of one city as a flat [x0, z0, x1, z1, …] list, each border once.
 * Edges that run along the city's outline are left out: the outline is drawn as a soft contour.
 */
export function districtBorders(sites: readonly CellSite[], cityRadius: number): number[] {
  if (sites.length < 2 || !(cityRadius > 0)) return [];
  const cells = districtCells(sites, cityRadius);
  // The outline is a 40-sided polygon: every point of it lies at least R·cos(π/40) from the centre,
  // and so does the midpoint of any piece of one side. A border between two districts is a chord.
  const outline = cityRadius * 0.9965;
  const q = cityRadius * 1e-4;
  const seen = new Set<string>();
  const out: number[] = [];
  for (const cell of cells) {
    const n = cell.length / 2;
    for (let i = 0; i < n; i++) {
      const x0 = cell[2 * i], z0 = cell[2 * i + 1];
      const x1 = cell[2 * ((i + 1) % n)], z1 = cell[2 * ((i + 1) % n) + 1];
      const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
      if (Math.hypot(mx, mz) >= outline) continue;
      if (Math.hypot(x1 - x0, z1 - z0) < q) continue;
      // an interior edge belongs to two cells: keep the first copy
      const key = `${Math.round(mx / q)},${Math.round(mz / q)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(x0, z0, x1, z1);
    }
  }
  return out;
}
