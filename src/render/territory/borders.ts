// Crisp district borders: the edges where two districts' territories meet, from the same cell
// construction physics uses for containment (territoryCells in src/shared/cells.ts), so a drawn
// border is where files actually stop. Pure. Coordinates are local to the city centre.
import { territoryCells, type TerritoryShape, type TerritorySite } from '../../shared/cells';

/**
 * The borders between the districts of one city as a flat [x0, z0, x1, z1, …] list, each border once.
 * Edges along a territory's own reach are left out: they are the city's outline, drawn as a soft contour.
 */
export function districtBorders(sites: readonly TerritorySite[], shape: TerritoryShape): number[] {
  if (sites.length < 2) return [];
  const cells = territoryCells(sites, shape);
  const out: number[] = [];
  cells.forEach((cell, i) => {
    const n = cell.ring.length / 2;
    for (let e = 0; e < n; e++) {
      const j = cell.neighbour[e];
      // a shared edge shows up in both cells: draw the copy of the lower-indexed one
      if (j < 0 || (j < i && cells[j].neighbour.includes(i))) continue;
      const k = (e + 1) % n;
      const x0 = cell.ring[2 * e], z0 = cell.ring[2 * e + 1], x1 = cell.ring[2 * k], z1 = cell.ring[2 * k + 1];
      if (Math.hypot(x1 - x0, z1 - z0) < 1e-6) continue;
      out.push(x0, z0, x1, z1);
    }
  });
  return out;
}
