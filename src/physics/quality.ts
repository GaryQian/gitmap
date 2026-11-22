// Layout quality numbers that are reported, never asserted (IMPLEMENTATION.md §3).
import { cellReach, type LocalCell } from './cells';
import type { PNode } from './sim';

const KEY_OFFSET = 32768;
const KEY_SPAN = 65536;

/**
 * Share of units that overlap another unit of the same district: a pair counts when its centres are
 * closer than `tolerance` × the sum of the two radii. Uses a spatial hash sized to the typical unit,
 * so a district with a few very large spheres does not degrade to all-pairs.
 */
export function overlapShare(districts: Iterable<readonly PNode[]>, tolerance: number): number {
  let total = 0, overlapping = 0;
  for (const nodes of districts) {
    const n = nodes.length;
    total += n;
    if (n < 2) continue;
    const radii = Float64Array.from(nodes, (nd) => nd.r).sort();
    const cell = Math.max(1e-6, 2 * radii[Math.floor(n * 0.75)]);
    const inv = 1 / cell;
    const grid = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
      const nd = nodes[i];
      const cx0 = Math.floor((nd.x - nd.r) * inv), cx1 = Math.floor((nd.x + nd.r) * inv);
      const cy0 = Math.floor((nd.y - nd.r) * inv), cy1 = Math.floor((nd.y + nd.r) * inv);
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cy = cy0; cy <= cy1; cy++) {
          const key = (cx + KEY_OFFSET) * KEY_SPAN + (cy + KEY_OFFSET);
          const arr = grid.get(key);
          if (arr) arr.push(i); else grid.set(key, [i]);
        }
      }
    }
    const hit = new Uint8Array(n);
    for (const arr of grid.values()) {
      for (let p = 0; p < arr.length; p++) {
        const a = nodes[arr[p]];
        for (let q = p + 1; q < arr.length; q++) {
          if (hit[arr[p]] && hit[arr[q]]) continue;
          const b = nodes[arr[q]];
          const dx = a.x - b.x, dy = a.y - b.y, rs = (a.r + b.r) * tolerance;
          if (dx * dx + dy * dy < rs * rs) { hit[arr[p]] = 1; hit[arr[q]] = 1; }
        }
      }
    }
    for (let i = 0; i < n; i++) overlapping += hit[i];
  }
  return total ? overlapping / total : 0;
}

/**
 * How evenly districts are filled from the middle to the edge. Each district's cell is cut into three
 * zones of equal area around its centroid (inner, middle and outer third, scaled along each bearing to
 * the cell's edge), and a zone's cover is the area of the unit discs centred in it over the zone's
 * area. Returned as the area-weighted mean over all districts with a cell: equal numbers mean an even
 * fill, a high inner and low outer number a pile at the centre and a sparse rim. A disc is counted
 * with its collide padding (`pad`), since the padded disc is the room a unit takes (small spheres are
 * mostly padding, so the bare-sphere cover of a rim of small files is lower), and it is shared between
 * the zones it straddles in proportion to how much of its width along the radius lies in each.
 */
export function coverByRadius(districts: Iterable<{ nodes: readonly PNode[]; cell: LocalCell | undefined }>, pad: number): { innerCover: number; middleCover: number; outerCover: number } {
  const disc = [0, 0, 0];
  let zone = 0;
  for (const { nodes, cell } of districts) {
    if (!cell || nodes.length < 12) continue;
    zone += cell.area / 3;
    for (const n of nodes) {
      const dx = n.x - cell.cx, dy = n.y - cell.cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      const reach = d > 1e-9 ? cellReach(cell, dx, dy) : Infinity;
      const rr = n.r + pad, area = Math.PI * rr * rr;
      if (!(reach > 0) || reach === Infinity) { disc[reach === Infinity ? 0 : 2] += area; continue; }
      const lo = Math.max(0, (d - rr) / reach), hi = Math.max(lo + 1e-9, Math.min(1, (d + rr) / reach));
      for (let z = 0; z < 3; z++) {
        const from = Math.sqrt(z / 3), to = z === 2 ? Infinity : Math.sqrt((z + 1) / 3);
        const part = Math.max(0, Math.min(hi, to) - Math.max(lo, from));
        disc[z] += (area * part) / (hi - lo);
      }
    }
  }
  return { innerCover: zone ? disc[0] / zone : 0, middleCover: zone ? disc[1] / zone : 0, outerCover: zone ? disc[2] / zone : 0 };
}
