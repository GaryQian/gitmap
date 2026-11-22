import { describe, expect, it } from 'vitest';
import { createReplica } from '../../model';
import type { PatchBatch, Poi } from '../../model/types';
import { syntheticBatch } from '../../testing/synthetic';
import { resolveBeams, touchesBeams } from './beams';

function poi(id: string, unit: string): Poi {
  return { type: 'poi', id, parent: `u:${unit}`, label: 'Entry', summary: 'Where it starts', kind: 'entry', evidence: 'main()', details: {} };
}

describe('beams from points of interest', () => {
  it('stand on the slot of their parent unit, and are dropped when the parent or the annotation goes', () => {
    const replica = createReplica();
    replica.apply(syntheticBatch({ files: 60, seed: 3 }));
    const units = replica.table('unit');
    const [a, b] = [units.ids[4]!, units.ids[9]!];
    const batches: PatchBatch[] = [
      { rev: 2, baseRev: 1, ops: [{ op: 'annotation', value: poi('p1', a) }, { op: 'annotation', value: poi('p2', b) }, { op: 'annotation', value: poi('p3', 'no/such/file.ts') }] },
      { rev: 3, baseRev: 2, ops: [{ op: 'remove', kind: 'unit', rows: { ids: [a], slots: [4], cols: {} } }] },
      { rev: 4, baseRev: 3, ops: [{ op: 'annotation', action: 'remove', value: poi('p2', b) }] },
    ];

    expect(touchesBeams(batches[0]!)).toBe(true);
    expect(replica.apply(batches[0]!)).toBe(true);
    const beams = resolveBeams(replica);
    expect(beams.map((x) => [x.id, x.slot])).toEqual([['p1', 4], ['p2', 9]]);
    for (const beam of beams) { expect(beam.seed).toBeGreaterThanOrEqual(0); expect(beam.seed).toBeLessThan(1); }

    expect(touchesBeams(batches[1]!)).toBe(true);
    expect(replica.apply(batches[1]!)).toBe(true);
    expect(resolveBeams(replica).map((x) => x.id)).toEqual(['p2']);

    expect(touchesBeams(batches[2]!)).toBe(true);
    expect(replica.apply(batches[2]!)).toBe(true);
    expect(resolveBeams(replica)).toEqual([]);
  });

  it('ignores batches that cannot change a beam', () => {
    expect(touchesBeams({ rev: 2, baseRev: 1, ops: [
      { op: 'progress', subsystem: 'history', done: 1, total: 2 },
      { op: 'annotation', value: { type: 'summary', id: 's1', parent: 'c:x', text: 'A summary' } },
      { op: 'update', kind: 'unit', rows: { ids: ['a.ts'], slots: [0], cols: { loc: [10] } } },
    ] })).toBe(false);
  });
});
