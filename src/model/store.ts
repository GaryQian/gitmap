// ModelStore: the single writer (PLAN.md §5.1).
//
// How a proposal is processed
//   Operations are validated one at a time, in order, against the store's own replica, and each one
//   is applied as soon as it passes — so a later operation sees everything earlier ones did. Every
//   applied operation leaves an undo step. If a later operation is invalid, the undo steps run in
//   reverse and the store ends exactly where it started; no batch is emitted. The cost of that
//   safety is proportional to the rows a proposal touches, never to the size of the model.
//   Nothing outside the store can observe the intermediate states, because subscribers are only
//   called after the whole proposal has been accepted.
//
// Decisions the contract left open
//   - A proposal of zero operations is accepted like any other: it produces an empty batch and a
//     new revision, and subscribers are notified. One call to `propose`, one batch.
//   - Emitted batches own their arrays: `ids` and columns are copied from the proposal, and small
//     objects (meta, annotations, layer definitions, `extra`) are structured-cloned.
//     Any `slots` / `units` / `districts` a proposal carries are ignored; the store fills them in.
//   - Slots: an add takes the lowest free slots of its kind first, then new ones at the end.
//   - `update`, `assign` and `layer` may name the same row twice; the later value wins.
//     `add` and `remove` may not.
//   - Beyond the contract's list, the store also rejects: an empty id, an `edge.kind` that is not an
//     EdgeKind, an add that leaves out a required reference column (`edge.src`, `edge.dst`,
//     `district.city`), and a layer `def` whose id differs from the layer's.
//     It does not check that `unit.primaryFile` names a file, that an edge id equals
//     edgeId(src, dst), or that an annotation's NodeRefs resolve.
//   - `assign` accepts '' as a district id ("no district"), like the optional `unit.district` column.
//   - Layer values must be finite or NaN. Every other number column must be finite.
//   - If a subscriber throws, the remaining subscribers are still called and the first error is then
//     rethrown from `propose` / `load`. Such an error is never a `ProposalError`: the batch was applied.
//   - A subscriber may call `propose` re-entrantly. The new batch is applied at once and delivered
//     after the current one, so every subscriber still sees batches in revision order.
//   - A replica's `capacity` only grows, while `fullBatch()` describes live rows. A replica rebuilt
//     from a full batch can therefore have fewer trailing empty slots than one that followed along.
//   - `fullBatch()` has `rev` = the current revision and `baseRev` = rev − 1 (−1 on a new store);
//     being `full`, it applies at any revision. It shares meta, annotation and layer-definition
//     objects with the store's replica: treat a batch as read-only.
//   - `load` builds the new state beside the old one and swaps it in only if the whole model is
//     valid; the emitted batch is `full` with slot = row index. `toModel` needs a meta to exist.
import { ProposalError, type ModelReplica, type ModelStore, type Unsub } from '../contracts/store';
import { Replica, type ResolvedRefs, type Table } from './replica';
import {
  COLUMN_DEFAULTS, ENTITY_KINDS, REFERENCE_COLUMNS,
  type Annotation, type ColumnChunk, type EdgeKind, type EntityKind, type EntityPatch, type Layer, type LayerDef,
  type LayerKind, type LayerStatus, type LayoutSnapshot, type ModelPatch, type PatchBatch, type Poi,
  type RepoMeta, type RepoModel, type SerializedLayer, type Summary, type Tour,
} from './types';

type AnyCols = Record<string, unknown[]>;
type AssignPatch = Extract<ModelPatch, { op: 'assign' }>;
type LayerPatch = Extract<ModelPatch, { op: 'layer' }>;
type AnnotationPatch = Extract<ModelPatch, { op: 'annotation' }>;
type MetaPatch = Extract<ModelPatch, { op: 'meta' }>;
type ProgressPatch = Extract<ModelPatch, { op: 'progress' }>;

interface RefColumn { col: string; target: EntityKind; optional: boolean }
interface KindInfo {
  names: string[];
  /** Column → true for a number column, false for a string column. */
  numeric: Record<string, boolean>;
  refs: RefColumn[];
  /** Some reference column of another kind points at this kind. */
  referenced: boolean;
}

const INFO = {} as Record<EntityKind, KindInfo>;
for (const kind of ENTITY_KINDS) {
  const defaults = COLUMN_DEFAULTS[kind] as Record<string, string | number>;
  const numeric: Record<string, boolean> = Object.create(null);
  for (const c of Object.keys(defaults)) numeric[c] = typeof defaults[c] === 'number';
  const refs = Object.entries(REFERENCE_COLUMNS[kind] as Record<string, { kind: EntityKind; optional: boolean }>)
    .map(([col, r]) => ({ col, target: r.kind, optional: r.optional }));
  INFO[kind] = { names: Object.keys(defaults), numeric, refs, referenced: false };
}
for (const kind of ENTITY_KINDS) for (const r of INFO[kind].refs) INFO[r.target].referenced = true;

// Records keyed by the union, so a new member in types.ts is a compile error here.
const EDGE_KINDS: Record<EdgeKind, true> = { import: true, call: true, reference: true, inherit: true, bridge: true };
const LAYER_KINDS: Record<LayerKind, true> = { scalar: true, categorical: true, sparse: true, parametric: true };
const LAYER_STATUSES: Record<LayerStatus, true> = { pending: true, partial: true, complete: true };
const ANNOTATION_TYPES: Record<Annotation['type'], true> = { poi: true, tour: true, summary: true };

function fail(opIndex: number, message: string): never {
  throw new ProposalError(`op ${opIndex}: ${message}`, opIndex);
}
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function own(o: object, key: unknown): boolean {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(o, key);
}
function clone<T>(value: T, opIndex: number, what: string): T {
  try { return structuredClone(value); } catch { return fail(opIndex, `${what} cannot be cloned (it must be plain data)`); }
}
function perKind<T>(make: (kind: EntityKind) => T): Record<EntityKind, T> {
  const out = {} as Record<EntityKind, T>;
  for (const k of ENTITY_KINDS) out[k] = make(k);
  return out;
}

/** What a proposal needs to put back if it is rejected, beyond running its undo steps. */
interface Tx {
  /** One step per applied operation, in application order. */
  undo: (() => void)[];
  capacity: Record<EntityKind, number>;
  lowestFree: Record<EntityKind, number>;
  meta: RepoMeta | null;
  annotations: Annotation[];
  /** Reference counts were written; rollback recounts them from the tables. */
  countsChanged: boolean;
}

/** A replica plus the bookkeeping only a writer needs: free slots and reference counts. */
class Core {
  readonly replica = new Replica();
  /** Per referenced kind, by slot: how many live rows point at that entity. */
  private refCount: Record<EntityKind, Int32Array> = perKind(() => new Int32Array(0));
  /** Per kind: every slot below this is occupied. Where the search for a free slot starts. */
  private lowestFree = perKind(() => 0);
  /** Per kind: scratch flags by slot, all zero between uses. */
  private marks: Record<EntityKind, Uint8Array> = perKind(() => new Uint8Array(0));
  private tx: Tx | null = null;

  // ---- transactions ----

  begin(): void {
    const r = this.replica;
    this.tx = {
      undo: [],
      capacity: perKind((k) => r.tables[k].capacity),
      lowestFree: { ...this.lowestFree },
      meta: r.meta,
      annotations: r.annotations,
      countsChanged: false,
    };
  }

  end(): void { this.tx = null; }

  rollback(): void {
    const tx = this.tx;
    if (!tx) return;
    this.tx = null;
    const r = this.replica;
    for (let k = tx.undo.length - 1; k >= 0; k--) tx.undo[k]();
    // Rows are back; now the things undo steps do not cover: growth, and the store's own bookkeeping.
    for (const kind of ENTITY_KINDS) r.tables[kind].truncate(tx.capacity[kind]);
    const unitCapacity = r.tables.unit.capacity;
    for (const layer of r.layers.values()) {
      if (layer.values.length > unitCapacity) layer.values = layer.values.slice(0, unitCapacity);
    }
    r.meta = tx.meta;               // the replica replaces these two on every write,
    r.annotations = tx.annotations; // so the objects saved at `begin` are untouched
    this.lowestFree = tx.lowestFree;
    if (tx.countsChanged) this.recount();
  }

  /** Become `other` (a core built by `load`). The replica object, and so its subscribers, stay. */
  adopt(other: Core): void {
    this.replica.adopt(other.replica);
    this.refCount = other.refCount;
    this.lowestFree = other.lowestFree;
  }

  private undo(step: () => void): void {
    this.tx?.undo.push(step);
  }

  /** Reference counts of a kind, about to be written: sized to the table. */
  private countsOf(kind: EntityKind): Int32Array {
    let counts = this.refCount[kind];
    if (this.tx) this.tx.countsChanged = true;
    const capacity = this.replica.tables[kind].capacity;
    if (counts.length < capacity) {
      const grown = new Int32Array(Math.max(capacity, counts.length * 2, 16));
      grown.set(counts);
      this.refCount[kind] = counts = grown;
    }
    return counts;
  }

  /** Rebuild every reference count from the tables (empty slots hold −1, so they count nothing). */
  private recount(): void {
    const tables = this.replica.tables;
    for (const kind of ENTITY_KINDS) this.refCount[kind].fill(0);
    for (const kind of ENTITY_KINDS) {
      const table = tables[kind];
      for (const ref of INFO[kind].refs) {
        const refSlots = table.refSlots[ref.col];
        const counts = this.countsOf(ref.target);
        for (let s = 0; s < table.capacity; s++) if (refSlots[s] >= 0) counts[refSlots[s]]++;
      }
    }
  }

  private marksOf(kind: EntityKind): Uint8Array {
    let marks = this.marks[kind];
    const capacity = this.replica.tables[kind].capacity;
    if (marks.length < capacity) marks = this.marks[kind] = new Uint8Array(Math.max(capacity, marks.length * 2, 16));
    return marks;
  }

  // ---- one operation: validate, apply, return what goes into the batch ----

  step(op: ModelPatch, i: number): ModelPatch {
    if (typeof op !== 'object' || op === null) fail(i, 'an operation must be an object');
    switch (op.op) {
      case 'add': return this.add(op, i);
      case 'update': return this.update(op, i);
      case 'remove': return this.remove(op, i);
      case 'assign': return this.assign(op, i);
      case 'layer': return this.layer(op, i);
      case 'annotation': return this.annotation(op, i);
      case 'meta': return this.meta(op, i);
      case 'progress': return this.progress(op, i);
      default: return fail(i, `unknown operation '${String((op as { op?: unknown }).op)}'`);
    }
  }

  private rows(op: EntityPatch, i: number): { kind: EntityKind; table: Table; ids: string[] } {
    const kind = op.kind;
    if (!own(INFO, kind)) fail(i, `${op.op}: unknown entity kind '${String(kind)}'`);
    const rows = op.rows as unknown;
    if (!isRecord(rows) || !Array.isArray(rows.ids)) fail(i, `${op.op} ${kind}: rows.ids must be an array`);
    const ids = (rows.ids as unknown[]).slice();
    for (let r = 0; r < ids.length; r++) {
      const id = ids[r];
      if (typeof id !== 'string' || id === '') fail(i, `${op.op} ${kind}: row ${r} has no id (ids are non-empty strings)`);
    }
    return { kind, table: this.replica.tables[kind] as Table, ids: ids as string[] };
  }

  /** Check a chunk's columns (names, lengths, value types, references) and copy them. */
  private columns(op: EntityPatch, kind: EntityKind, ids: string[], i: number): { cols: AnyCols; refs: ResolvedRefs | undefined } {
    const given = op.rows.cols as unknown;
    if (!isRecord(given)) fail(i, `${op.op} ${kind}: rows.cols must be an object`);
    const info = INFO[kind];
    const n = ids.length;
    const cols: AnyCols = {};
    for (const c of Object.keys(given)) {
      if (!(c in info.numeric)) fail(i, `${op.op} ${kind}: unknown column '${c}'`);
      const values = given[c];
      if (!Array.isArray(values)) fail(i, `${op.op} ${kind}: column '${c}' must be an array`);
      if (values.length !== n) fail(i, `${op.op} ${kind}: column '${c}' has ${values.length} values for ${n} ids`);
      if (info.numeric[c]) {
        for (let r = 0; r < n; r++) {
          if (!Number.isFinite(values[r])) fail(i, `${op.op} ${kind}: ${c} of '${ids[r]}' must be a finite number, got ${describe(values[r])}`);
        }
      } else {
        for (let r = 0; r < n; r++) {
          if (typeof values[r] !== 'string') fail(i, `${op.op} ${kind}: ${c} of '${ids[r]}' must be a string, got ${describe(values[r])}`);
        }
      }
      cols[c] = values.slice();
    }
    if (kind === 'edge' && cols.kind) {
      const kinds = cols.kind as string[];
      for (let r = 0; r < n; r++) if (!own(EDGE_KINDS, kinds[r])) fail(i, `${op.op} edge: '${kinds[r]}' is not an edge kind ('${ids[r]}')`);
    }
    let refs: ResolvedRefs | undefined;
    for (const ref of info.refs) {
      const values = cols[ref.col] as string[] | undefined;
      if (!values) {
        if (op.op === 'add' && !ref.optional && n > 0) fail(i, `add ${kind}: column '${ref.col}' is required`);
        continue;
      }
      const target = this.replica.tables[ref.target];
      const slots = new Int32Array(n);
      for (let r = 0; r < n; r++) {
        const id = values[r];
        if (id === '') {
          if (!ref.optional) fail(i, `${op.op} ${kind}: ${ref.col} of '${ids[r]}' is empty`);
          slots[r] = -1;
        } else {
          const s = target.slotOf(id);
          if (s < 0) fail(i, `${op.op} ${kind}: ${ref.col} of '${ids[r]}' names ${ref.target} '${id}', which does not exist`);
          slots[r] = s;
        }
      }
      (refs ??= {})[ref.col] = slots;
    }
    return { cols, refs };
  }

  private add(op: EntityPatch, i: number): ModelPatch {
    const { kind, table, ids } = this.rows(op, i);
    const { cols, refs } = this.columns(op, kind, ids, i);
    const n = ids.length;

    // Reserve slots: the lowest free ones, then new ones at the end. Occupying each slot as it is
    // chosen is also what catches an id that appears twice in this chunk.
    const capacityBefore = table.capacity;
    table.grow(table.count + n); // exactly enough empty slots for every row
    const slots = new Array<number>(n);
    const live = table.ids;
    let free = this.lowestFree[kind];
    for (let r = 0; r < n; r++) {
      while (free < table.capacity && live[free] !== null) free++;
      if (!table.reserve(free, ids[r])) {
        slots.length = r;
        table.clearMany(slots);
        table.truncate(capacityBefore);
        fail(i, `add ${kind}: '${ids[r]}' already exists`);
      }
      slots[r] = free++;
    }
    this.lowestFree[kind] = free;

    const replica = this.replica;
    const inverse = { op: 'remove', kind, rows: { ids, cols: {}, slots } } as EntityPatch;
    this.undo(() => replica.applyOp(inverse));
    if (refs) {
      for (const ref of INFO[kind].refs) {
        const targets = refs[ref.col];
        if (!targets) continue;
        const counts = this.countsOf(ref.target);
        for (let r = 0; r < n; r++) if (targets[r] >= 0) counts[targets[r]]++;
      }
    }
    const out = { op: 'add', kind, rows: { ids, cols, slots } } as EntityPatch;
    replica.applyOp(out, refs);
    return out;
  }

  private update(op: EntityPatch, i: number): ModelPatch {
    const { kind, table, ids } = this.rows(op, i);
    const n = ids.length;
    const slots = new Array<number>(n);
    for (let r = 0; r < n; r++) {
      const s = table.slotOf(ids[r]);
      if (s < 0) fail(i, `update ${kind}: '${ids[r]}' does not exist`);
      slots[r] = s;
    }
    const { cols, refs } = this.columns(op, kind, ids, i);

    const current = table.cols as unknown as AnyCols;
    const before: AnyCols = {};
    for (const c in cols) {
      const src = current[c], old = new Array<unknown>(n);
      for (let r = 0; r < n; r++) old[r] = src[slots[r]];
      before[c] = old;
    }
    const replica = this.replica;
    const inverse = { op: 'update', kind, rows: { ids, cols: before, slots } } as EntityPatch;
    this.undo(() => replica.applyOp(inverse)); // reference slots are looked up again from the old ids

    if (refs) {
      for (const ref of INFO[kind].refs) {
        const targets = refs[ref.col];
        if (targets) this.retarget(table.refSlots[ref.col], slots, targets, this.countsOf(ref.target));
      }
    }
    const out = { op: 'update', kind, rows: { ids, cols, slots } } as EntityPatch;
    replica.applyOp(out, refs);
    return out;
  }

  /**
   * Move reference counts from each row's present target to its new one. Rows are taken in order and
   * the reference slot is rewritten as we go, so a row listed twice is counted correctly. The
   * replica writes the same values again when the operation is applied.
   */
  private retarget(refSlots: number[], slots: number[], targets: ArrayLike<number>, counts: Int32Array): void {
    for (let r = 0; r < slots.length; r++) {
      const s = slots[r], from = refSlots[s], to = targets[r];
      if (from === to) continue;
      if (from >= 0) counts[from]--;
      if (to >= 0) counts[to]++;
      refSlots[s] = to;
    }
  }

  private remove(op: EntityPatch, i: number): ModelPatch {
    const { kind, table, ids } = this.rows(op, i);
    const info = INFO[kind];
    const n = ids.length;
    const slots = new Array<number>(n);
    const marks = this.marksOf(kind);
    const counts = info.referenced ? this.refCount[kind] : null;
    let problem = '';
    let marked = 0;
    for (; marked < n; marked++) {
      const id = ids[marked];
      const s = table.slotOf(id);
      if (s < 0) problem = `'${id}' does not exist`;
      else if (marks[s]) problem = `'${id}' is listed twice`;
      else if (counts && counts[s] > 0) problem = `'${id}' is still referenced by ${counts[s]} live row(s); remove or re-point them first`;
      if (problem) break;
      marks[s] = 1;
      slots[marked] = s;
    }
    for (let r = 0; r < marked; r++) marks[slots[r]] = 0;
    if (problem) fail(i, `remove ${kind}: ${problem}`);

    const current = table.cols as unknown as AnyCols;
    const before: AnyCols = {};
    for (const c of info.names) {
      const src = current[c], old = new Array<unknown>(n);
      for (let r = 0; r < n; r++) old[r] = src[slots[r]];
      before[c] = old;
    }
    const replica = this.replica;
    const inverse = { op: 'add', kind, rows: { ids, cols: before, slots } } as EntityPatch;
    // Removing a unit also blanks its value in every layer; keep those values for the way back.
    const blanked: [Layer, Float32Array][] = [];
    if (kind === 'unit' && this.tx) {
      for (const layer of replica.layers.values()) {
        const old = new Float32Array(n);
        for (let r = 0; r < n; r++) old[r] = layer.values[slots[r]];
        blanked.push([layer, old]);
      }
    }
    this.undo(() => {
      replica.applyOp(inverse);
      for (const [layer, old] of blanked) {
        const values = layer.values;
        for (let r = 0; r < n; r++) values[slots[r]] = old[r];
      }
    });

    for (const ref of info.refs) {
      const refSlots = table.refSlots[ref.col];
      const targetCounts = this.countsOf(ref.target);
      for (let r = 0; r < n; r++) {
        const target = refSlots[slots[r]];
        if (target >= 0) targetCounts[target]--;
      }
    }
    let lowest = this.lowestFree[kind];
    for (let r = 0; r < n; r++) if (slots[r] < lowest) lowest = slots[r];
    this.lowestFree[kind] = lowest;

    const out = { op: 'remove', kind, rows: { ids, cols: {}, slots } } as EntityPatch;
    replica.applyOp(out);
    return out;
  }

  private assign(op: AssignPatch, i: number): ModelPatch {
    if (!Array.isArray(op.unitIds) || !Array.isArray(op.districtIds)) fail(i, 'assign: unitIds and districtIds must be arrays');
    if (op.unitIds.length !== op.districtIds.length) fail(i, `assign: ${op.unitIds.length} unit ids for ${op.districtIds.length} district ids`);
    const unitIds = op.unitIds.slice(), districtIds = op.districtIds.slice();
    const n = unitIds.length;
    const unitTable = this.replica.tables.unit, districtTable = this.replica.tables.district;
    const units = new Array<number>(n), districts = new Array<number>(n);
    for (let r = 0; r < n; r++) {
      const u = unitIds[r], d = districtIds[r];
      const us = typeof u === 'string' ? unitTable.slotOf(u) : -1;
      if (us < 0) fail(i, `assign: unit '${String(u)}' does not exist`);
      const ds = d === '' ? -1 : typeof d === 'string' ? districtTable.slotOf(d) : -2;
      if (ds < -1 || (ds < 0 && d !== '')) fail(i, `assign: district '${String(d)}' does not exist`);
      units[r] = us;
      districts[r] = ds;
    }

    const column = unitTable.cols.district, refSlots = unitTable.refSlots.district;
    const beforeIds = new Array<string>(n), beforeSlots = new Array<number>(n);
    for (let r = 0; r < n; r++) { beforeIds[r] = column[units[r]]; beforeSlots[r] = refSlots[units[r]]; }
    const replica = this.replica;
    const inverse: AssignPatch = { op: 'assign', unitIds, districtIds: beforeIds, units, districts: beforeSlots };
    this.undo(() => replica.applyOp(inverse));

    this.retarget(refSlots, units, districts, this.countsOf('district'));
    const out: AssignPatch = { op: 'assign', unitIds, districtIds, units, districts };
    replica.applyOp(out);
    return out;
  }

  private layer(op: LayerPatch, i: number): ModelPatch {
    const id = op.id;
    if (typeof id !== 'string' || id === '') fail(i, 'layer: id must be a non-empty string');
    if (!Array.isArray(op.unitIds) || !Array.isArray(op.values)) fail(i, `layer '${id}': unitIds and values must be arrays`);
    if (op.unitIds.length !== op.values.length) fail(i, `layer '${id}': ${op.values.length} values for ${op.unitIds.length} unit ids`);
    if (!this.replica.layers.has(id) && op.def === undefined) fail(i, `layer '${id}': the first patch for a layer must carry its def`);
    if (op.def !== undefined) checkLayerDef(op.def, id, i);
    if (op.status !== undefined && !own(LAYER_STATUSES, op.status)) fail(i, `layer '${id}': unknown status '${String(op.status)}'`);
    if (op.coverage !== undefined && !Number.isFinite(op.coverage)) fail(i, `layer '${id}': coverage must be a finite number`);
    if (op.extra !== undefined && !isRecord(op.extra)) fail(i, `layer '${id}': extra must be an object`);

    const unitIds = op.unitIds.slice(), values = op.values.slice();
    const n = unitIds.length;
    const unitTable = this.replica.tables.unit;
    const slots = new Array<number>(n);
    for (let r = 0; r < n; r++) {
      const u = unitIds[r], v = values[r];
      const s = typeof u === 'string' ? unitTable.slotOf(u) : -1;
      if (s < 0) fail(i, `layer '${id}': unit '${String(u)}' does not exist`);
      if (typeof v !== 'number' || v === Infinity || v === -Infinity) fail(i, `layer '${id}': value for '${u}' must be a finite number or NaN, got ${describe(v)}`);
      slots[r] = s;
    }

    const out: LayerPatch = { op: 'layer', id, unitIds, values, slots };
    if (op.def !== undefined) out.def = clone(op.def, i, `layer '${id}' def`);
    if (op.status !== undefined) out.status = op.status;
    if (op.coverage !== undefined) out.coverage = op.coverage;
    if (op.extra !== undefined) out.extra = clone(op.extra, i, `layer '${id}' extra`);

    const layers = this.replica.layers;
    const layer = layers.get(id);
    if (!layer) this.undo(() => { layers.delete(id); });
    else if (this.tx) {
      const { def, status, coverage, extra } = layer;
      const old = new Float32Array(n);
      for (let r = 0; r < n; r++) old[r] = layer.values[slots[r]];
      this.undo(() => {
        layer.def = def; layer.status = status; layer.coverage = coverage;
        if (extra === undefined) delete layer.extra; else layer.extra = extra;
        const stored = layer.values;
        for (let r = n - 1; r >= 0; r--) stored[slots[r]] = old[r]; // backwards: a unit listed twice gets its first value back
      });
    }
    this.replica.applyOp(out);
    return out;
  }

  private annotation(op: AnnotationPatch, i: number): ModelPatch {
    const value = op.value as unknown;
    if (!isRecord(value) || !own(ANNOTATION_TYPES, value.type)) fail(i, "annotation: value.type must be 'poi', 'tour' or 'summary'");
    if (typeof value.id !== 'string' || value.id === '') fail(i, 'annotation: value.id must be a non-empty string');
    if (op.action !== undefined && op.action !== 'set' && op.action !== 'remove') fail(i, `annotation: unknown action '${String(op.action)}'`);
    const out: AnnotationPatch = { op: 'annotation', value: clone(op.value, i, 'annotation') };
    if (op.action !== undefined) out.action = op.action;
    this.replica.applyOp(out); // undone by restoring the array saved at `begin`
    return out;
  }

  private meta(op: MetaPatch, i: number): ModelPatch {
    if (!isRecord(op.value)) fail(i, 'meta: value must be an object');
    const out: MetaPatch = { op: 'meta', value: clone(op.value, i, 'meta') };
    this.replica.applyOp(out); // likewise
    return out;
  }

  private progress(op: ProgressPatch, i: number): ModelPatch {
    if (typeof op.subsystem !== 'string') fail(i, 'progress: subsystem must be a string');
    if (!Number.isFinite(op.done) || !Number.isFinite(op.total)) fail(i, 'progress: done and total must be finite numbers');
    if (op.label !== undefined && typeof op.label !== 'string') fail(i, 'progress: label must be a string');
    const out: ProgressPatch = { op: 'progress', subsystem: op.subsystem, done: op.done, total: op.total };
    if (op.label !== undefined) out.label = op.label;
    return out;
  }
}

function describe(v: unknown): string {
  return typeof v === 'string' ? `'${v}'` : typeof v === 'number' ? String(v) : v === null ? 'null' : typeof v;
}

function checkLayerDef(def: LayerDef, id: string, i: number): void {
  if (!isRecord(def)) fail(i, `layer '${id}': def must be an object`);
  if (def.id !== id) fail(i, `layer '${id}': def.id is '${String(def.id)}'`);
  if (!own(LAYER_KINDS, def.kind)) fail(i, `layer '${id}': unknown def.kind '${String(def.kind)}'`);
  if (typeof def.label !== 'string' || typeof def.colormap !== 'string') fail(i, `layer '${id}': def.label and def.colormap must be strings`);
  const d = def.domain as unknown;
  if (!Array.isArray(d) || d.length !== 2 || !Number.isFinite(d[0]) || !Number.isFinite(d[1])) fail(i, `layer '${id}': def.domain must be two finite numbers`);
}

/** Live rows of a table as a chunk: ids, every column, and the slots they occupy. Fresh arrays. */
function liveRows(table: Table): { ids: string[]; cols: AnyCols; slots: number[] } {
  const source = table.cols as unknown as AnyCols;
  const cols: AnyCols = {};
  if (table.count === table.capacity) {
    const slots = new Array<number>(table.capacity);
    for (let s = 0; s < slots.length; s++) slots[s] = s;
    for (const c in source) cols[c] = source[c].slice(0, table.capacity);
    return { ids: table.ids.slice(0, table.capacity) as string[], cols, slots };
  }
  const slots = table.slots();
  const n = slots.length;
  const ids = new Array<string>(n);
  for (let r = 0; r < n; r++) ids[r] = table.ids[slots[r]]!;
  for (const c in source) {
    const src = source[c], out = new Array<unknown>(n);
    for (let r = 0; r < n; r++) out[r] = src[slots[r]];
    cols[c] = out;
  }
  return { ids, cols, slots };
}

/** A saved model as proposal operations, in an order where every reference resolves. */
function modelOps(model: RepoModel): ModelPatch[] {
  const ops: ModelPatch[] = [{ op: 'meta', value: model.meta }];
  const tables = (model.tables ?? {}) as Partial<Record<EntityKind, ColumnChunk>>;
  for (const kind of ENTITY_KINDS) {
    const rows = tables[kind];
    if (rows?.ids?.length) ops.push({ op: 'add', kind, rows: { ids: rows.ids, cols: rows.cols ?? {} } } as EntityPatch);
  }
  const allUnits = tables.unit?.ids ?? [];
  for (const [id, layer] of Object.entries(model.layers ?? {})) {
    const saved = Array.isArray(layer?.values) ? layer.values : [];
    if (saved.length !== allUnits.length) throw new Error(`cannot load: layer '${id}' has ${saved.length} values for ${allUnits.length} units`);
    const unitIds: string[] = [], values: number[] = [];
    for (let r = 0; r < saved.length; r++) {
      const v = saved[r];
      if (v === null) continue; // unknown: the layer starts out NaN everywhere
      unitIds.push(allUnits[r]);
      values.push(v);
    }
    const op: LayerPatch = { op: 'layer', id, def: layer.def, unitIds, values, status: layer.status, coverage: layer.coverage };
    if (layer.extra !== undefined) op.extra = layer.extra;
    ops.push(op);
  }
  const a = model.annotations;
  for (const value of [...(a?.pois ?? []), ...(a?.tours ?? []), ...(a?.summaries ?? [])]) ops.push({ op: 'annotation', action: 'set', value });
  return ops;
}

class Store implements ModelStore {
  private readonly core = new Core();
  private revision = 0;
  private subs: { fn: (batch: PatchBatch) => void }[] = [];
  private outbox: PatchBatch[] = [];
  private delivering = false;

  get rev(): number { return this.revision; }
  get replica(): ModelReplica { return this.core.replica; }

  propose(ops: ModelPatch[]): PatchBatch {
    if (!Array.isArray(ops)) throw new ProposalError('a proposal must be an array of operations', -1);
    const core = this.core;
    const out = new Array<ModelPatch>(ops.length);
    core.begin();
    try {
      for (let i = 0; i < ops.length; i++) out[i] = core.step(ops[i], i);
    } catch (e) {
      core.rollback();
      throw e;
    }
    core.end();
    return this.commit(out, false);
  }

  subscribe(fn: (batch: PatchBatch) => void): Unsub {
    const entry = { fn };
    this.subs.push(entry);
    return () => {
      const i = this.subs.indexOf(entry);
      if (i >= 0) this.subs.splice(i, 1);
    };
  }

  fullBatch(): PatchBatch {
    const r = this.core.replica;
    const ops: ModelPatch[] = [];
    if (r.meta) ops.push({ op: 'meta', value: r.meta });
    for (const kind of ENTITY_KINDS) {
      const table = r.tables[kind] as Table;
      if (table.count) ops.push({ op: 'add', kind, rows: liveRows(table) } as EntityPatch);
    }
    const units = r.tables.unit;
    for (const [id, layer] of r.layers) {
      const unitIds: string[] = [], values: number[] = [], slots: number[] = [];
      const stored = layer.values;
      for (let s = 0; s < units.capacity; s++) {
        const v = stored[s];
        if (v !== v) continue; // NaN: unknown, and what a fresh layer holds anyway
        unitIds.push(units.ids[s]!);
        values.push(v);
        slots.push(s);
      }
      const op: LayerPatch = { op: 'layer', id, def: layer.def, unitIds, values, slots, status: layer.status, coverage: layer.coverage };
      if (layer.extra !== undefined) op.extra = layer.extra;
      ops.push(op);
    }
    for (const value of r.annotations) ops.push({ op: 'annotation', action: 'set', value });
    return { rev: this.revision, baseRev: this.revision - 1, ops, full: true };
  }

  load(model: RepoModel): PatchBatch {
    if (!isRecord(model)) throw new Error('cannot load: not a model');
    if (model.schema !== 1) throw new Error(`cannot load a model with schema ${JSON.stringify(model.schema)}: this build reads schema 1`);
    if (!isRecord(model.meta)) throw new Error('cannot load: the model has no meta');
    // Build the new state beside the present one, through the same validation as any proposal.
    // If the model is invalid this throws and the store has not been touched.
    const ops = modelOps(model);
    const next = new Core();
    const out = new Array<ModelPatch>(ops.length);
    for (let i = 0; i < ops.length; i++) out[i] = next.step(ops[i], i);
    this.core.adopt(next);
    return this.commit(out, true);
  }

  toModel(layout?: LayoutSnapshot): RepoModel {
    const r = this.core.replica;
    if (!r.meta) throw new Error('toModel: the model has no meta yet (propose a meta operation first)');
    const tables = {} as Record<EntityKind, ColumnChunk>;
    for (const kind of ENTITY_KINDS) {
      const { ids, cols } = liveRows(r.tables[kind] as Table);
      tables[kind] = { ids, cols } as ColumnChunk;
    }
    const unitSlots = r.tables.unit.slots();
    const layers: Record<string, SerializedLayer> = {};
    for (const [id, layer] of r.layers) {
      const values = new Array<number | null>(unitSlots.length);
      for (let k = 0; k < unitSlots.length; k++) {
        const v = layer.values[unitSlots[k]];
        values[k] = v !== v ? null : v;
      }
      const saved: SerializedLayer = { def: structuredClone(layer.def), status: layer.status, coverage: layer.coverage, values };
      if (layer.extra !== undefined) saved.extra = structuredClone(layer.extra);
      layers[id] = saved;
    }
    const pois: Poi[] = [], tours: Tour[] = [], summaries: Summary[] = [];
    for (const a of r.annotations) {
      const copy = structuredClone(a);
      if (copy.type === 'poi') pois.push(copy); else if (copy.type === 'tour') tours.push(copy); else summaries.push(copy);
    }
    const model: RepoModel = {
      schema: 1,
      meta: structuredClone(r.meta),
      tables: tables as RepoModel['tables'],
      layers,
      annotations: { pois, tours, summaries },
    };
    if (layout) model.layout = layout;
    return model;
  }

  private commit(ops: ModelPatch[], full: boolean): PatchBatch {
    const baseRev = this.revision, rev = baseRev + 1;
    const batch: PatchBatch = full ? { rev, baseRev, ops, full: true } : { rev, baseRev, ops };
    this.revision = rev;
    this.core.replica.rev = rev;
    this.outbox.push(batch);
    this.deliver();
    return batch;
  }

  /** Hand queued batches to the replica's subscribers, then the store's, in revision order. */
  private deliver(): void {
    if (this.delivering) return; // a subscriber proposed: the loop below picks the new batch up
    this.delivering = true;
    let failed = false, error: unknown;
    const caught = (e: unknown) => { if (!failed) { failed = true; error = e; } };
    try {
      while (this.outbox.length) {
        const batch = this.outbox.shift()!;
        try { this.core.replica.notify(batch); } catch (e) { caught(e); }
        for (const { fn } of this.subs.slice()) {
          try { fn(batch); } catch (e) { caught(e); }
        }
      }
    } finally {
      this.delivering = false;
    }
    if (failed) throw error;
  }
}

export function createModelStore(): ModelStore {
  return new Store();
}
