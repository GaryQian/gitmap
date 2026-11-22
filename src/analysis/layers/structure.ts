// The little of the model's structure the layer builders need, in row form, read from either a
// replica (live slots, ascending) or the StructureTables analysis produced. Pure.
import type { ModelReplica } from '../../contracts/store';
import type { StructureTables } from '../../model/types';

export interface UnitIndex {
  /** One row per unit. */
  unitIds: string[];
  unitLang: string[];
  filePaths: string[];
  /** Row of the unit each file belongs to; −1 when it has none. */
  fileUnit: Int32Array;
  /** Unit rows of each edge: src depends on dst. */
  edgeSrc: Int32Array;
  edgeDst: Int32Array;
}

export type StructureSource = ModelReplica | StructureTables | UnitIndex;

/** out[i] = rowOf(refs[i]), as a typed array (a plain loop: this runs once per history chunk). */
function rows<T>(refs: ArrayLike<T> | undefined, n: number, rowOf: (ref: T) => number): Int32Array {
  const out = new Int32Array(n).fill(-1);
  if (refs) for (let i = 0; i < n; i++) out[i] = rowOf(refs[i]);
  return out;
}

function isReplica(source: StructureSource): source is ModelReplica {
  return typeof (source as ModelReplica).table === 'function';
}

export function unitIndex(source: StructureSource): UnitIndex {
  if ('unitIds' in source) return source;
  if (isReplica(source)) {
    const units = source.table('unit'), files = source.table('file'), edges = source.table('edge');
    const rowOf = new Int32Array(units.capacity).fill(-1);
    const unitIds: string[] = [], unitLang: string[] = [];
    for (const s of units.slots()) { rowOf[s] = unitIds.length; unitIds.push(units.ids[s]!); unitLang.push(units.cols.lang[s]); }
    const fileSlots = files.slots(), edgeSlots = edges.slots();
    const via = (ref: number[]) => (slot: number) => { const u = ref[slot] ?? -1; return u >= 0 && u < rowOf.length ? rowOf[u] : -1; };
    return {
      unitIds, unitLang,
      filePaths: fileSlots.map((f) => files.ids[f]!),
      fileUnit: rows(fileSlots, fileSlots.length, via(files.refSlots.unit)),
      edgeSrc: rows(edgeSlots, edgeSlots.length, via(edges.refSlots.src)),
      edgeDst: rows(edgeSlots, edgeSlots.length, via(edges.refSlots.dst)),
    };
  }
  const { unit, file, edge } = source;
  const rowOf = new Map<string, number>();
  unit.ids.forEach((id, r) => rowOf.set(id, r));
  const row = (id: string) => rowOf.get(id) ?? -1;
  return {
    unitIds: unit.ids,
    unitLang: unit.ids.map((_, r) => unit.cols.lang?.[r] ?? 'other'),
    filePaths: file.ids,
    fileUnit: rows(file.cols.unit, file.ids.length, row),
    edgeSrc: rows(edge.cols.src, edge.ids.length, row),
    edgeDst: rows(edge.cols.dst, edge.ids.length, row),
  };
}
