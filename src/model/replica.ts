// ModelReplica: a copy of the model kept in step by applying batches in order (PLAN.md §5.1).
// Written in Round 0 so every package has a working replica from day one; owned by 1A afterwards.
// It trusts its input: validation is the store's job.
import type { ModelReplica, ReplicaTable, Unsub } from '../contracts/store';
import {
  COLUMN_DEFAULTS, ENTITY_KINDS, REFERENCE_COLUMNS,
  type Annotation, type EntityColumns, type EntityKind, type Layer, type LayerId, type ModelPatch, type PatchBatch, type RepoMeta,
} from './types';

class Table<K extends EntityKind> implements ReplicaTable<K> {
  capacity = 0;
  count = 0;
  ids: (string | null)[] = [];
  cols: EntityColumns[K];
  refSlots: Record<string, number[]> = {};
  private index = new Map<string, number>();

  constructor(readonly kind: K) {
    const cols: Record<string, unknown[]> = {};
    for (const c of Object.keys(COLUMN_DEFAULTS[kind])) cols[c] = [];
    this.cols = cols as unknown as EntityColumns[K];
    for (const c of Object.keys(REFERENCE_COLUMNS[kind])) this.refSlots[c] = [];
  }

  slotOf(id: string): number { return this.index.get(id) ?? -1; }
  has(id: string): boolean { return this.index.has(id); }
  slots(): number[] {
    const out: number[] = [];
    for (let s = 0; s < this.capacity; s++) if (this.ids[s] !== null && this.ids[s] !== undefined) out.push(s);
    return out;
  }

  private grow(slot: number): void {
    const defaults = COLUMN_DEFAULTS[this.kind] as Record<string, unknown>;
    const cols = this.cols as unknown as Record<string, unknown[]>;
    while (this.capacity <= slot) {
      const s = this.capacity++;
      this.ids[s] = null;
      for (const c in cols) cols[c][s] = defaults[c];
      for (const c in this.refSlots) this.refSlots[c][s] = -1;
    }
  }

  put(slot: number, id: string): void {
    this.grow(slot);
    if (this.ids[slot] === null) this.count++;
    else this.index.delete(this.ids[slot]!);
    this.ids[slot] = id;
    this.index.set(id, slot);
  }

  set(slot: number, col: string, value: unknown): void {
    (this.cols as unknown as Record<string, unknown[]>)[col][slot] = value;
  }

  clear(slot: number): void {
    const id = this.ids[slot];
    if (id === null || id === undefined) return;
    this.index.delete(id);
    this.ids[slot] = null;
    this.count--;
    const defaults = COLUMN_DEFAULTS[this.kind] as Record<string, unknown>;
    const cols = this.cols as unknown as Record<string, unknown[]>;
    for (const c in cols) cols[c][slot] = defaults[c];
    for (const c in this.refSlots) this.refSlots[c][slot] = -1;
  }

  reset(): void {
    this.capacity = 0; this.count = 0; this.ids = []; this.index.clear();
    for (const c in this.cols) (this.cols as unknown as Record<string, unknown[]>)[c] = [];
    for (const c in this.refSlots) this.refSlots[c] = [];
  }
}

export class Replica implements ModelReplica {
  rev = 0;
  meta: RepoMeta | null = null;
  layers = new Map<LayerId, Layer>();
  annotations: Annotation[] = [];
  private tables = new Map<EntityKind, Table<EntityKind>>();
  private subs = new Set<(batch: PatchBatch) => void>();

  constructor() {
    for (const k of ENTITY_KINDS) this.tables.set(k, new Table(k));
  }

  table<K extends EntityKind>(kind: K): ReplicaTable<K> {
    return this.tables.get(kind) as unknown as ReplicaTable<K>;
  }

  subscribe(fn: (batch: PatchBatch) => void): Unsub {
    this.subs.add(fn);
    return () => { this.subs.delete(fn); };
  }

  apply(batch: PatchBatch): boolean {
    if (!batch.full && batch.baseRev !== this.rev) return false;
    if (batch.full) this.clearAll();
    for (const op of batch.ops) this.applyOp(op);
    this.rev = batch.rev;
    for (const fn of [...this.subs]) fn(batch);
    return true;
  }

  private clearAll(): void {
    for (const t of this.tables.values()) t.reset();
    this.layers.clear();
    this.annotations = [];
    this.meta = null;
  }

  private resolveRefs(t: Table<EntityKind>, slot: number, col: string, id: string): void {
    const ref = (REFERENCE_COLUMNS[t.kind] as Record<string, { kind: EntityKind } | undefined>)[col];
    if (ref) t.refSlots[col][slot] = id === '' ? -1 : this.tables.get(ref.kind)!.slotOf(id);
  }

  private applyOp(op: ModelPatch): void {
    switch (op.op) {
      case 'add':
      case 'update': {
        const t = this.tables.get(op.kind)!;
        const { ids, slots } = op.rows;
        if (!slots) throw new Error(`replica: ${op.op} ${op.kind} without slots`);
        const cols = op.rows.cols as Record<string, unknown[]>;
        for (let i = 0; i < ids.length; i++) {
          const slot = slots[i];
          if (op.op === 'add') t.put(slot, ids[i]);
          for (const c in cols) {
            t.set(slot, c, cols[c][i]);
            this.resolveRefs(t, slot, c, cols[c][i] as string);
          }
        }
        break;
      }
      case 'remove': {
        const t = this.tables.get(op.kind)!;
        const slots = op.rows.slots;
        if (!slots) throw new Error(`replica: remove ${op.kind} without slots`);
        for (const s of slots) t.clear(s);
        break;
      }
      case 'assign': {
        const units = this.tables.get('unit')!;
        if (!op.units || !op.districts) throw new Error('replica: assign without slots');
        for (let i = 0; i < op.units.length; i++) {
          units.set(op.units[i], 'district', op.districtIds[i]);
          units.refSlots.district[op.units[i]] = op.districts[i];
        }
        break;
      }
      case 'layer': {
        let layer = this.layers.get(op.id);
        const cap = this.tables.get('unit')!.capacity;
        if (!layer) {
          if (!op.def) throw new Error(`replica: first patch for layer ${op.id} has no def`);
          layer = { def: op.def, status: 'pending', coverage: 0, values: new Float32Array(cap).fill(NaN) };
          this.layers.set(op.id, layer);
        } else if (op.def) layer.def = op.def;
        if (layer.values.length < cap) {
          const grown = new Float32Array(cap).fill(NaN);
          grown.set(layer.values);
          layer.values = grown;
        }
        if (op.slots) for (let i = 0; i < op.slots.length; i++) layer.values[op.slots[i]] = op.values[i] ?? NaN;
        if (op.status) layer.status = op.status;
        if (op.coverage !== undefined) layer.coverage = op.coverage;
        if (op.extra) layer.extra = { ...layer.extra, ...op.extra };
        break;
      }
      case 'annotation': {
        const v = op.value;
        this.annotations = this.annotations.filter((a) => !(a.type === v.type && a.id === v.id));
        if (op.action !== 'remove') this.annotations.push(v);
        break;
      }
      case 'meta':
        this.meta = { ...(this.meta ?? ({} as RepoMeta)), ...op.value };
        break;
      case 'progress':
        break;
    }
  }
}

export function createReplica(): ModelReplica {
  return new Replica();
}
