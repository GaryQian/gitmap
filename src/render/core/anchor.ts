// World anchors of nodes, composed on the CPU the same way the shaders compose them. Pure.
import type { Config } from '../../config';
import type { PositionBuffers } from '../../contracts/physics';
import type { ModelReplica } from '../../contracts/store';
import { parseRef, type NodeRef } from '../../model/types';
import { unitRadius } from '../../shared';

/** A node's anchor: a unit's centre (y = r), or a district's or city's centre on the ground (r = territory radius). */
export interface Anchor { x: number; y: number; z: number; r: number }

/** Unit slot for a `u:` or `f:` ref, or −1. */
export function unitSlotOf(ref: NodeRef, replica: ModelReplica): number {
  let parsed;
  try { parsed = parseRef(ref); } catch { return -1; }
  if (parsed.kind === 'unit') return replica.table('unit').slotOf(parsed.id);
  if (parsed.kind === 'file') {
    const files = replica.table('file');
    const f = files.slotOf(parsed.id);
    return f < 0 ? -1 : (files.refSlots.unit[f] ?? -1);
  }
  return -1;
}

/** World ground position of a unit slot, or null when it has no district or lies outside the buffers. */
export function unitGround(slot: number, replica: ModelReplica, pos: PositionBuffers): { x: number; z: number } | null {
  const d = replica.table('unit').refSlots.district[slot] ?? -1;
  if (d < 0 || 2 * slot + 1 >= pos.unit.length || 3 * d + 2 >= pos.district.length) return null;
  const c = replica.table('district').refSlots.city[d] ?? -1;
  if (c < 0 || 3 * c + 2 >= pos.city.length) return null;
  return {
    x: pos.city[3 * c] + pos.district[3 * d] + pos.unit[2 * slot],
    z: pos.city[3 * c + 1] + pos.district[3 * d + 1] + pos.unit[2 * slot + 1],
  };
}

export function anchorOf(ref: NodeRef, replica: ModelReplica, pos: PositionBuffers, visual: Config['visual']): Anchor | null {
  let parsed;
  try { parsed = parseRef(ref); } catch { return null; }
  if (parsed.kind === 'unit' || parsed.kind === 'file') {
    const slot = unitSlotOf(ref, replica);
    if (slot < 0) return null;
    const g = unitGround(slot, replica, pos);
    if (!g) return null;
    const units = replica.table('unit');
    const r = unitRadius(units.cols.loc[slot], units.cols.importancePct[slot], visual);
    return { x: g.x, y: r, z: g.z, r };
  }
  if (parsed.kind === 'district') {
    const districts = replica.table('district');
    const d = districts.slotOf(parsed.id);
    if (d < 0 || 3 * d + 2 >= pos.district.length) return null;
    const c = districts.refSlots.city[d] ?? -1;
    if (c < 0 || 3 * c + 2 >= pos.city.length) return null;
    return { x: pos.city[3 * c] + pos.district[3 * d], y: 0, z: pos.city[3 * c + 1] + pos.district[3 * d + 1], r: pos.district[3 * d + 2] };
  }
  const c = replica.table('city').slotOf(parsed.id);
  if (c < 0 || 3 * c + 2 >= pos.city.length) return null;
  return { x: pos.city[3 * c], y: 0, z: pos.city[3 * c + 1], r: pos.city[3 * c + 2] };
}

export interface Bounds { x: number; z: number; r: number }

/** Bounding circle of every live city (centre of their bounding box), or null when there is none. */
export function mapBounds(replica: ModelReplica, pos: PositionBuffers): Bounds | null {
  const cities = replica.table('city');
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, n = 0;
  for (let c = 0; c < cities.capacity; c++) {
    if (cities.ids[c] == null || 3 * c + 2 >= pos.city.length) continue;
    const x = pos.city[3 * c], z = pos.city[3 * c + 1], r = pos.city[3 * c + 2];
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(r)) continue;
    minX = Math.min(minX, x - r); maxX = Math.max(maxX, x + r);
    minZ = Math.min(minZ, z - r); maxZ = Math.max(maxZ, z + r);
    n++;
  }
  if (!n) return null;
  const x = (minX + maxX) / 2, z = (minZ + maxZ) / 2;
  let r = 0;
  for (let c = 0; c < cities.capacity; c++) {
    if (cities.ids[c] == null || 3 * c + 2 >= pos.city.length) continue;
    const d = Math.hypot(pos.city[3 * c] - x, pos.city[3 * c + 1] - z) + pos.city[3 * c + 2];
    if (Number.isFinite(d)) r = Math.max(r, d);
  }
  return { x, z, r };
}
