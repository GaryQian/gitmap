// Shared by the tests in this folder; not part of the public surface.
import type { ModelReplica } from '../contracts/store';
import { ENTITY_KINDS, type ColumnChunk, type EntityKind } from './types';

/**
 * Everything a replica holds, in a shape `toEqual` can compare. Trailing empty slots are dropped:
 * a replica rebuilt from a full batch does not know about slots that were freed at the end.
 */
export function view(replica: ModelReplica): unknown {
  const tables: Record<string, unknown> = {};
  let unitLength = 0;
  for (const kind of ENTITY_KINDS) {
    const t = replica.table(kind);
    let length = t.capacity;
    while (length > 0 && t.ids[length - 1] === null) length--;
    if (kind === 'unit') unitLength = length;
    const cols: Record<string, unknown[]> = {}, refSlots: Record<string, number[]> = {};
    for (const [c, values] of Object.entries(t.cols as Record<string, unknown[]>)) cols[c] = values.slice(0, length);
    for (const [c, values] of Object.entries(t.refSlots)) refSlots[c] = values.slice(0, length);
    tables[kind] = { count: t.count, ids: t.ids.slice(0, length), cols, refSlots };
  }
  const layers: Record<string, unknown> = {};
  for (const [id, layer] of replica.layers) {
    layers[id] = { def: layer.def, status: layer.status, coverage: layer.coverage, extra: layer.extra, values: Array.from(layer.values.slice(0, unitLength)) };
  }
  return { tables, layers, meta: replica.meta, annotations: replica.annotations };
}

/** A chunk as id → { column: value }, so tables can be compared whatever their row order. */
export function rowsById(chunk: ColumnChunk<EntityKind>): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  const cols = chunk.cols as Record<string, unknown[]>;
  chunk.ids.forEach((id, r) => {
    const row: Record<string, unknown> = {};
    for (const c of Object.keys(cols)) row[c] = cols[c][r];
    out.set(id, row);
  });
  return out;
}
