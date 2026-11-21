// ModelReplica: a copy of the model kept in step by applying batches in order (PLAN.md §5.1).
// It trusts its input: validation is the store's job (store.ts). The store keeps one of these as
// its own view and writes to it through `applyOp`, the same code every other replica runs.
//
// Guarantees worth knowing:
//   - Empty slots hold COLUMN_DEFAULTS, a null id and −1 reference slots.
//   - Every layer's `values` has exactly one entry per unit slot (length === unit capacity); a slot
//     that is empty, or was emptied and reused, reads NaN until a layer patch sets it.
//   - A `full` batch rebuilds everything from empty. Column arrays are replaced by a full batch (and
//     `Layer.values` whenever unit capacity grows), so read them through `table(kind)` / `layers`
//     each time instead of holding on to the arrays across batches. Table objects and the `layers`
//     map themselves are stable for the life of the replica.
//   - If applying a batch throws, the replica refuses every later batch except a `full` one.
import type { ModelReplica, ReplicaTable, Unsub } from '../contracts/store';
import {
  COLUMN_DEFAULTS, ENTITY_KINDS, REFERENCE_COLUMNS,
  type Annotation, type EntityColumns, type EntityKind, type Layer, type LayerId, type ModelPatch, type PatchBatch, type RepoMeta,
} from './types';

type AnyCols = Record<string, unknown[]>;

/** Target slots the store already looked up, per reference column, in row order (−1 = none). */
export type ResolvedRefs = Record<string, ArrayLike<number>>;

const DEFAULTS = COLUMN_DEFAULTS as Record<EntityKind, Record<string, string | number>>;
const REFS = REFERENCE_COLUMNS as Record<EntityKind, Record<string, { kind: EntityKind; optional: boolean } | undefined>>;

export class Table<K extends EntityKind = EntityKind> implements ReplicaTable<K> {
  capacity = 0;
  count = 0;
  ids: (string | null)[] = [];
  cols: EntityColumns[K];
  refSlots: Record<string, number[]> = {};
  private index = new Map<string, number>();
  private readonly colNames: string[];
  private readonly refNames: string[];

  constructor(readonly kind: K) {
    this.colNames = Object.keys(DEFAULTS[kind]);
    this.refNames = Object.keys(REFS[kind]);
    const cols: AnyCols = {};
    for (const c of this.colNames) cols[c] = [];
    this.cols = cols as unknown as EntityColumns[K];
    for (const c of this.refNames) this.refSlots[c] = [];
  }

  slotOf(id: string): number {
    const s = this.index.get(id);
    return s === undefined ? -1 : s;
  }
  has(id: string): boolean { return this.index.has(id); }
  slots(): number[] {
    const out: number[] = [];
    const ids = this.ids;
    for (let s = 0; s < this.capacity; s++) if (ids[s] !== null) out.push(s);
    return out;
  }

  /** Make sure slots below `capacity` exist. New slots are empty and hold the defaults. */
  grow(capacity: number): void {
    const from = this.capacity;
    if (capacity <= from) return;
    const ids = this.ids;
    for (let s = from; s < capacity; s++) ids[s] = null;
    const cols = this.cols as unknown as AnyCols;
    for (const c of this.colNames) {
      const a = cols[c], d = DEFAULTS[this.kind][c];
      for (let s = from; s < capacity; s++) a[s] = d;
    }
    for (const c of this.refNames) {
      const a = this.refSlots[c];
      for (let s = from; s < capacity; s++) a[s] = -1;
    }
    this.capacity = capacity;
  }

  /** Occupy a slot. Putting the id a slot already holds changes nothing. */
  put(slot: number, id: string): void {
    if (slot >= this.capacity) this.grow(slot + 1);
    const prev = this.ids[slot];
    if (prev === id) return;
    if (prev !== null) this.clear(slot); // not expected from a store; keeps the table consistent anyway
    this.count++;
    this.ids[slot] = id;
    this.index.set(id, slot);
  }

  /**
   * Occupy an empty slot, unless the id is already in the table: then nothing changes and the
   * answer is false. One hash lookup per row on the path the store takes for every added row.
   */
  reserve(slot: number, id: string): boolean {
    const index = this.index, size = index.size;
    index.set(id, slot);
    if (index.size === size) {
      index.set(id, this.ids.indexOf(id)); // put the entry back; slow, but only on a rejected proposal
      return false;
    }
    if (slot >= this.capacity) this.grow(slot + 1);
    this.ids[slot] = id;
    this.count++;
    return true;
  }

  /** Empty a slot: null id, default columns, no references. */
  clear(slot: number): void {
    if (slot < 0 || slot >= this.capacity) return;
    const id = this.ids[slot];
    if (id === null) return;
    if (this.index.get(id) === slot) this.index.delete(id);
    this.ids[slot] = null;
    this.count--;
    const cols = this.cols as unknown as AnyCols;
    for (const c of this.colNames) cols[c][slot] = DEFAULTS[this.kind][c];
    for (const c of this.refNames) this.refSlots[c][slot] = -1;
  }

  /** Empty many slots, column by column. */
  clearMany(slots: number[]): void {
    const ids = this.ids, index = this.index, n = slots.length;
    for (let i = 0; i < n; i++) {
      const s = slots[i], id = ids[s];
      if (id === null || id === undefined) continue;
      index.delete(id);
      ids[s] = null;
      this.count--;
    }
    const cols = this.cols as unknown as AnyCols;
    for (const c of this.colNames) {
      const a = cols[c], d = DEFAULTS[this.kind][c];
      for (let i = 0; i < n; i++) a[slots[i]] = d;
    }
    for (const c of this.refNames) {
      const a = this.refSlots[c];
      for (let i = 0; i < n; i++) a[slots[i]] = -1;
    }
  }

  /** Drop trailing slots. They must be empty already (the store uses this to undo growth). */
  truncate(capacity: number): void {
    if (capacity >= this.capacity) return;
    this.ids.length = capacity;
    const cols = this.cols as unknown as AnyCols;
    for (const c of this.colNames) cols[c].length = capacity;
    for (const c of this.refNames) this.refSlots[c].length = capacity;
    this.capacity = capacity;
  }

  reset(): void {
    this.capacity = 0; this.count = 0; this.ids = []; this.index = new Map();
    const cols = this.cols as unknown as AnyCols;
    for (const c of this.colNames) cols[c] = [];
    for (const c of this.refNames) this.refSlots[c] = [];
  }

  /** Take over another table's rows, leaving it empty. This object keeps its identity. */
  takeFrom(other: Table<K>): void {
    this.capacity = other.capacity; this.count = other.count; this.ids = other.ids; this.index = other.index;
    const cols = this.cols as unknown as AnyCols, theirs = other.cols as unknown as AnyCols;
    for (const c of this.colNames) cols[c] = theirs[c];
    for (const c of this.refNames) this.refSlots[c] = other.refSlots[c];
    other.reset();
  }
}

export class Replica implements ModelReplica {
  rev = 0;
  meta: RepoMeta | null = null;
  readonly layers = new Map<LayerId, Layer>();
  annotations: Annotation[] = [];
  readonly tables: { [K in EntityKind]: Table<K> };
  private subs: { fn: (batch: PatchBatch) => void }[] = [];
  /** Set while a batch is half-applied; stays set if applying throws, until a full batch arrives. */
  private broken = false;

  constructor() {
    const tables: Partial<Record<EntityKind, Table>> = {};
    for (const k of ENTITY_KINDS) tables[k] = new Table(k);
    this.tables = tables as unknown as { [K in EntityKind]: Table<K> };
  }

  table<K extends EntityKind>(kind: K): ReplicaTable<K> {
    return this.tables[kind];
  }

  subscribe(fn: (batch: PatchBatch) => void): Unsub {
    const entry = { fn };
    this.subs.push(entry);
    return () => {
      const i = this.subs.indexOf(entry);
      if (i >= 0) this.subs.splice(i, 1);
    };
  }

  apply(batch: PatchBatch): boolean {
    if (!batch.full && (this.broken || batch.baseRev !== this.rev)) return false;
    this.broken = true;
    if (batch.full) this.clearAll();
    const ops = batch.ops;
    for (let i = 0; i < ops.length; i++) this.applyOp(ops[i]);
    this.broken = false;
    this.rev = batch.rev;
    this.notify(batch);
    return true;
  }

  /** Call every subscriber, in subscription order. One that throws does not stop the others. */
  notify(batch: PatchBatch): void {
    let failed = false, error: unknown;
    for (const { fn } of this.subs.slice()) {
      try { fn(batch); } catch (e) { if (!failed) { failed = true; error = e; } }
    }
    if (failed) throw error;
  }

  clearAll(): void {
    for (const k of ENTITY_KINDS) this.tables[k].reset();
    this.layers.clear();
    this.annotations = [];
    this.meta = null;
  }

  /** Take over another replica's whole state (the store's `load`). Revision and subscribers stay. */
  adopt(other: Replica): void {
    for (const k of ENTITY_KINDS) (this.tables[k] as Table).takeFrom(other.tables[k] as Table);
    this.layers.clear();
    for (const [id, layer] of other.layers) this.layers.set(id, layer);
    other.layers.clear();
    this.annotations = other.annotations;
    this.meta = other.meta;
    this.broken = false;
  }

  /**
   * Apply one operation of an emitted batch. `refs` is the store's shortcut: reference slots it has
   * already resolved while validating, so its own replica does not look them up a second time.
   */
  applyOp(op: ModelPatch, refs?: ResolvedRefs): void {
    switch (op.op) {
      case 'add': {
        const t = this.tables[op.kind] as Table;
        const { ids, slots } = op.rows;
        if (!slots) throw new Error(`replica: add ${op.kind} without slots`);
        const n = ids.length;
        let max = -1;
        for (let i = 0; i < n; i++) if (slots[i] > max) max = slots[i];
        t.grow(max + 1);
        for (let i = 0; i < n; i++) t.put(slots[i], ids[i]);
        this.writeCols(t, slots, n, op.rows.cols as AnyCols, refs);
        // not "if the table grew just now": the store occupies the slots before it applies the op
        if (op.kind === 'unit') this.growLayers(t.capacity);
        break;
      }
      case 'update': {
        const t = this.tables[op.kind] as Table;
        const slots = op.rows.slots;
        if (!slots) throw new Error(`replica: update ${op.kind} without slots`);
        this.writeCols(t, slots, slots.length, op.rows.cols as AnyCols, refs);
        break;
      }
      case 'remove': {
        const t = this.tables[op.kind] as Table;
        const slots = op.rows.slots;
        if (!slots) throw new Error(`replica: remove ${op.kind} without slots`);
        t.clearMany(slots);
        if (op.kind === 'unit') {
          for (const layer of this.layers.values()) {
            const values = layer.values;
            for (let i = 0; i < slots.length; i++) values[slots[i]] = NaN;
          }
        }
        break;
      }
      case 'assign': {
        const t = this.tables.unit;
        const { units, districts, districtIds } = op;
        if (!units || !districts) throw new Error('replica: assign without slots');
        const col = t.cols.district, ref = t.refSlots.district;
        for (let i = 0; i < units.length; i++) {
          col[units[i]] = districtIds[i];
          ref[units[i]] = districts[i];
        }
        break;
      }
      case 'layer': {
        let layer = this.layers.get(op.id);
        if (!layer) {
          if (!op.def) throw new Error(`replica: first patch for layer ${op.id} has no def`);
          layer = { def: op.def, status: 'pending', coverage: 0, values: new Float32Array(this.tables.unit.capacity).fill(NaN) };
          this.layers.set(op.id, layer);
        } else if (op.def) layer.def = op.def;
        const { slots, values } = op;
        if (slots) {
          const out = layer.values;
          for (let i = 0; i < slots.length; i++) out[slots[i]] = values[i] ?? NaN;
        }
        if (op.status) layer.status = op.status;
        if (op.coverage !== undefined) layer.coverage = op.coverage;
        if (op.extra) layer.extra = { ...layer.extra, ...op.extra };
        break;
      }
      case 'annotation': {
        const v = op.value;
        const next = this.annotations.filter((a) => !(a.type === v.type && a.id === v.id));
        if (op.action !== 'remove') next.push(v);
        this.annotations = next;
        break;
      }
      case 'meta':
        this.meta = { ...(this.meta ?? ({} as RepoMeta)), ...op.value };
        break;
      case 'progress':
        break;
    }
  }

  /** Column by column, so the inner loops stay tight for large chunks. Later rows win on a repeated slot. */
  private writeCols(t: Table, slots: number[], n: number, cols: AnyCols, refs: ResolvedRefs | undefined): void {
    const dstCols = t.cols as unknown as AnyCols;
    for (const c in cols) {
      const src = cols[c], dst = dstCols[c];
      if (!dst) continue;
      for (let i = 0; i < n; i++) dst[slots[i]] = src[i];
      const ref = REFS[t.kind][c];
      if (!ref) continue;
      const out = t.refSlots[c];
      const known = refs?.[c];
      if (known) {
        for (let i = 0; i < n; i++) out[slots[i]] = known[i];
      } else {
        const target = this.tables[ref.kind];
        for (let i = 0; i < n; i++) {
          const id = src[i] as string;
          out[slots[i]] = id === '' ? -1 : target.slotOf(id);
        }
      }
    }
  }

  /** Keep every layer at one value per unit slot; new slots are unknown (NaN). */
  private growLayers(capacity: number): void {
    for (const layer of this.layers.values()) {
      const old = layer.values;
      if (old.length >= capacity) continue;
      const grown = new Float32Array(capacity);
      grown.set(old);
      grown.fill(NaN, old.length);
      layer.values = grown;
    }
  }
}

export function createReplica(): ModelReplica {
  return new Replica();
}
