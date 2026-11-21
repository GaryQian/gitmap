// diffStructure: the proposal that turns a replica's structure into the structure analysis produced.
//
// Order of the result, chosen so the whole list passes `store.propose` on a store in the replica's state:
//   1. adds, in dependency order (city, district, unit, file, edge)
//   2. updates, one operation per kind and per set of changed columns, so each carries only columns
//      that changed for every row in it
//   3. one `assign` for units whose only change is their district
//   4. removes, in reverse dependency order (edge, file, unit, district, city) — by then nothing
//      that stays still points at them
//
// Reading `next`:
//   - A kind's chunk lists every row that should exist; rows the replica has and `next` does not are removed.
//   - A column missing from a chunk means "leave as is" for rows that already exist (and the default
//     for new rows). Reference columns should always be present, or a row may keep pointing at
//     something this diff removes and the store will reject the proposal.
//   - Numbers closer than a relative 1e-9 count as equal.
//   - When the replica has no rows of a kind, the add reuses the chunk's own arrays (no copy). The
//     store copies what it is given, so this only matters to a caller that edits the ops by hand.
import type { DiffStructure } from '../contracts/store';
import { COLUMN_DEFAULTS, type EntityKind, type EntityPatch, type ModelPatch, type StructureTables } from './types';

type AnyCols = Record<string, unknown[]>;
type StructureKind = keyof StructureTables;

const ADD_ORDER: StructureKind[] = ['city', 'district', 'unit', 'file', 'edge'];
const REMOVE_ORDER: StructureKind[] = ['edge', 'file', 'unit', 'district', 'city'];
const EPSILON = 1e-9;
const DEFAULTS = COLUMN_DEFAULTS as Record<EntityKind, Record<string, string | number>>;

function sameNumber(a: number, b: number): boolean {
  return Math.abs(a - b) <= EPSILON * Math.max(1, Math.abs(a), Math.abs(b));
}

function pick(source: unknown[], rows: number[]): unknown[] {
  const out = new Array<unknown>(rows.length);
  for (let k = 0; k < rows.length; k++) out[k] = source[rows[k]];
  return out;
}

export const diffStructure: DiffStructure = (current, next: StructureTables) => {
  const adds: ModelPatch[] = [];
  const updates: ModelPatch[] = [];
  const removes: Partial<Record<StructureKind, ModelPatch>> = {};
  let assign: ModelPatch | null = null;

  for (const kind of ADD_ORDER) {
    const chunk = next[kind];
    const table = current.table(kind);
    const ids = chunk.ids;
    const cols = chunk.cols as AnyCols;
    const n = ids.length;

    if (table.count === 0) {
      if (n) adds.push({ op: 'add', kind, rows: { ids, cols } } as EntityPatch);
      continue;
    }

    // Columns that can be compared: the ones `next` carries and the model knows.
    const have = table.cols as unknown as AnyCols;
    const names = Object.keys(cols).filter((c) => c in have);
    const mine = names.map((c) => have[c]);
    const theirs = names.map((c) => cols[c]);
    const numeric = names.map((c) => typeof DEFAULTS[kind][c] === 'number');

    const kept = new Uint8Array(table.capacity);
    const added: number[] = [];
    /** Rows of `next` that changed, grouped by which columns changed (a bit per entry of `names`). */
    const changed = new Map<number, number[]>();
    for (let r = 0; r < n; r++) {
      const slot = table.slotOf(ids[r]);
      if (slot < 0) { added.push(r); continue; }
      kept[slot] = 1;
      let mask = 0;
      for (let k = 0; k < names.length; k++) {
        const a = mine[k][slot], b = theirs[k][r];
        if (a !== b && !(numeric[k] && sameNumber(a as number, b as number))) mask |= 1 << k;
      }
      if (mask === 0) continue;
      const group = changed.get(mask);
      if (group) group.push(r); else changed.set(mask, [r]);
    }

    if (added.length) {
      const addCols: AnyCols = {};
      for (const c in cols) addCols[c] = pick(cols[c], added);
      adds.push({ op: 'add', kind, rows: { ids: pick(ids, added) as string[], cols: addCols } } as EntityPatch);
    }

    for (const [mask, rows] of changed) {
      const changedNames = names.filter((_, k) => mask & (1 << k));
      if (kind === 'unit' && changedNames.length === 1 && changedNames[0] === 'district') {
        assign = { op: 'assign', unitIds: pick(ids, rows) as string[], districtIds: pick(cols.district, rows) as string[] };
        continue;
      }
      const updateCols: AnyCols = {};
      for (const c of changedNames) updateCols[c] = pick(cols[c], rows);
      updates.push({ op: 'update', kind, rows: { ids: pick(ids, rows) as string[], cols: updateCols } } as EntityPatch);
    }

    const gone: string[] = [];
    for (let s = 0; s < table.capacity; s++) {
      const id = table.ids[s];
      if (id !== null && !kept[s]) gone.push(id);
    }
    if (gone.length) removes[kind] = { op: 'remove', kind, rows: { ids: gone, cols: {} } } as EntityPatch;
  }

  const ops = adds.concat(updates);
  if (assign) ops.push(assign);
  for (const kind of REMOVE_ORDER) {
    const op = removes[kind];
    if (op) ops.push(op);
  }
  return ops;
};
