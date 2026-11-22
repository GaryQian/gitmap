// Unit graph by slot, and Dependency reach over it (PLAN.md §10). Pure; runs on the main thread in
// well under a frame at 10,000 units.
import type { ModelReplica } from '../contracts/store';

/** Out- and in-neighbours per unit slot, in CSR form: neighbours of s are targets[offsets[s] .. offsets[s + 1]). */
export interface Adjacency {
  /** Unit capacity the arrays were built for. */
  capacity: number;
  /** Units s depends on (edges s → x). */
  outOffsets: Uint32Array;
  outTargets: Uint32Array;
  /** Units that depend on s (edges x → s). */
  inOffsets: Uint32Array;
  inTargets: Uint32Array;
  /** Replica revision it was built at; rebuild when edges change. */
  rev: number;
}

export type ReachDirection = 'dependsOn' | 'dependedOnBy';

export function buildAdjacency(replica: ModelReplica): Adjacency {
  const capacity = replica.table('unit').capacity;
  const edges = replica.table('edge');
  const src = edges.refSlots.src, dst = edges.refSlots.dst;
  const outOffsets = new Uint32Array(capacity + 1), inOffsets = new Uint32Array(capacity + 1);
  const live: number[] = [];
  for (let e = 0; e < edges.capacity; e++) {
    if (edges.ids[e] === null) continue;
    const s = src[e], d = dst[e];
    if (!(s >= 0 && s < capacity && d >= 0 && d < capacity)) continue;
    live.push(e);
    outOffsets[s + 1]++;
    inOffsets[d + 1]++;
  }
  for (let s = 0; s < capacity; s++) { outOffsets[s + 1] += outOffsets[s]; inOffsets[s + 1] += inOffsets[s]; }
  const outTargets = new Uint32Array(live.length), inTargets = new Uint32Array(live.length);
  const outNext = outOffsets.slice(0, capacity), inNext = inOffsets.slice(0, capacity);
  for (const e of live) {
    const s = src[e], d = dst[e];
    outTargets[outNext[s]++] = d;
    inTargets[inNext[d]++] = s;
  }
  return { capacity, outOffsets, outTargets, inOffsets, inTargets, rev: replica.rev };
}

/**
 * Hop counts from the seeds, breadth first: 0 for seeds, NaN for units that cannot be reached (or
 * lie beyond `maxHops`). 'dependsOn' follows edges from a unit to what it depends on;
 * 'dependedOnBy' follows them backwards.
 */
export function computeReach(adjacency: Adjacency, seedSlots: Iterable<number>, direction: ReachDirection, maxHops = Infinity): Float32Array {
  const { capacity } = adjacency;
  const offsets = direction === 'dependsOn' ? adjacency.outOffsets : adjacency.inOffsets;
  const targets = direction === 'dependsOn' ? adjacency.outTargets : adjacency.inTargets;
  const hops = new Float32Array(capacity).fill(NaN);
  const queue = new Uint32Array(capacity);
  let head = 0, tail = 0;
  for (const s of seedSlots) {
    if (!(s >= 0 && s < capacity) || hops[s] === 0) continue;
    hops[s] = 0;
    queue[tail++] = s;
  }
  while (head < tail) {
    const s = queue[head++];
    const next = hops[s] + 1;
    if (next > maxHops) continue;
    for (let i = offsets[s]; i < offsets[s + 1]; i++) {
      const t = targets[i];
      if (hops[t] === hops[t]) continue; // already reached (not NaN)
      hops[t] = next;
      queue[tail++] = t;
    }
  }
  return hops;
}
