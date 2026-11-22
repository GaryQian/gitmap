// Which beams the model asks for: one per point of interest whose parent file still exists. Pure.
import type { ModelReplica } from '../../contracts/store';
import type { PatchBatch } from '../../model/types';
import { hash32 } from '../../shared';
import { unitSlotOf } from '../core/anchor';

/** Floats per instance: the parent's unit slot, and a seed in 0..1. */
export const BEAM_ITEMS = 2;

export interface Beam {
  /** The point of interest's id. */
  id: string;
  /** Unit slot of the star it stands on (PLAN.md §11.3: always a file's sphere). */
  slot: number;
  /** 0..1, stable per id: gives each beam its own shimmer phase. */
  seed: number;
}

/** One beam per point of interest in the replica, in annotation order; one whose parent is gone is dropped. */
export function resolveBeams(replica: ModelReplica): Beam[] {
  const beams: Beam[] = [];
  for (const a of replica.annotations) {
    if (a.type !== 'poi') continue;
    const slot = unitSlotOf(a.parent, replica);
    if (slot >= 0) beams.push({ id: a.id, slot, seed: hash32(a.id) / 4294967296 });
  }
  return beams;
}

/**
 * Can this batch change the set of beams or the slots they stand on? Points of interest set or
 * removed, and units added or removed. Nothing else matters here: a parent that moves, or changes
 * district, is followed in the shader through the unit lookup.
 */
export function touchesBeams(batch: PatchBatch): boolean {
  for (const op of batch.ops) {
    if (op.op === 'annotation') { if (op.value.type === 'poi') return true; }
    else if ((op.op === 'add' || op.op === 'remove') && op.kind === 'unit') return true;
  }
  return false;
}

/** Write the per-instance rows for `beams` into `out` (BEAM_ITEMS floats each). */
export function writeBeams(beams: readonly Beam[], out: Float32Array): void {
  beams.forEach((b, i) => {
    out[i * BEAM_ITEMS] = b.slot;
    out[i * BEAM_ITEMS + 1] = b.seed;
  });
}
