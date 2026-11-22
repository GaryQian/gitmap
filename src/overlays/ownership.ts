// Ownership is parametric: the layer carries every unit's author counts, and the share for the
// chosen contributor is computed here, on the main thread, with no round trip (PLAN.md §10).
import type { ModelReplica } from '../contracts/store';
import type { Layer } from '../model/types';
import type { HistoryContributor, OwnershipExtra } from './types';

/** The layer's side data, or null when it is missing or malformed (a layer that is still pending). */
export function ownershipExtra(layer: Pick<Layer, 'extra'> | null | undefined): OwnershipExtra | null {
  const x = layer?.extra as Partial<OwnershipExtra> | undefined;
  if (!x || !Array.isArray(x.unitIds) || !Array.isArray(x.offsets) || !Array.isArray(x.authorIds) || !Array.isArray(x.authorCommits)) return null;
  if (x.offsets.length !== x.unitIds.length + 1) return null;
  return { unitIds: x.unitIds, offsets: x.offsets, authorIds: x.authorIds, authorCommits: x.authorCommits, contributors: Array.isArray(x.contributors) ? x.contributors : [] };
}

/** Contributors for the picker, most commits first. */
export function ownershipContributors(layer: Pick<Layer, 'extra'> | null | undefined): HistoryContributor[] {
  return ownershipExtra(layer)?.contributors ?? [];
}

/**
 * One contributor's share of the commits to each unit, by unit slot: 0..1, NaN where the unit has
 * no history (yet).
 */
export function ownershipShare(layer: Pick<Layer, 'extra'> | null | undefined, contributorId: number, replica: ModelReplica): Float32Array {
  const units = replica.table('unit');
  const out = new Float32Array(units.capacity).fill(NaN);
  const x = ownershipExtra(layer);
  if (!x) return out;
  const { unitIds, offsets, authorIds, authorCommits } = x;
  for (let r = 0; r < unitIds.length; r++) {
    const slot = units.slotOf(unitIds[r]);
    if (slot < 0) continue;
    let total = 0, mine = 0;
    for (let i = offsets[r]; i < offsets[r + 1]; i++) {
      total += authorCommits[i];
      if (authorIds[i] === contributorId) mine += authorCommits[i];
    }
    if (total > 0) out[slot] = mine / total;
  }
  return out;
}
