import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ProposalError, type ModelReplica } from '../contracts/store';
import { syntheticMeta, syntheticTables, tablesToOps } from '../testing/synthetic';
import {
  createModelStore, createReplica, edgeId, ENTITY_KINDS, REFERENCE_COLUMNS,
  type Annotation, type EdgeKind, type EntityKind, type LayerDef, type LayerStatus, type ModelPatch, type PatchBatch, type RepoMeta,
} from './index';
import { view } from './testHelpers';

const layerDef = (id: string): LayerDef => ({ id, kind: 'scalar', label: id, domain: [0, 1], colormap: 'viridis' });
const EDGE_KINDS: EdgeKind[] = ['import', 'call', 'reference', 'inherit', 'bridge'];
const STATUSES: LayerStatus[] = ['pending', 'partial', 'complete'];

/** One random step of a scenario. The numbers are only raw material for picking rows. */
interface Command { type: string; a: number; b: number; n: number; x: number }

/**
 * Turns commands into valid proposals by keeping its own picture of what exists. It tracks changes
 * op by op, so later ops of a proposal build on earlier ones exactly as the store validates them.
 */
class Scenario {
  private seq = 0;
  cities: string[] = [];
  districts = new Map<string, string>();        // id → city
  units = new Map<string, string>();            // id → district or ''
  files = new Map<string, string>();            // id → unit or ''
  edges = new Map<string, [string, string]>();  // id → [src, dst]
  contributors = new Set<string>();
  layers = new Set<string>();
  annotations = new Map<string, Annotation>();  // type:id → value, in the order the model keeps them
  meta: Partial<RepoMeta> | null = null;
  /** Ids of removed units, to add again later: an id may come back in another slot. */
  private removedUnits: string[] = [];
  /** The most rows each kind has held at once. */
  peak: Record<EntityKind, number> = { city: 0, district: 0, unit: 0, file: 0, edge: 0, contributor: 0 };

  sizes(): Record<EntityKind, number> {
    return { city: this.cities.length, district: this.districts.size, unit: this.units.size, file: this.files.size, edge: this.edges.size, contributor: this.contributors.size };
  }

  private some<T>(from: Iterable<T>, start: number, count: number): T[] {
    const all = [...from];
    const out: T[] = [];
    for (let k = 0; k < Math.min(count, all.length); k++) out.push(all[(start + k) % all.length]);
    return out;
  }

  /** Operations for one command. Each command only adds rows of a kind or only removes them, so sizes peak between commands. */
  ops(c: Command): ModelPatch[] {
    const out = this.build(c);
    const sizes = this.sizes();
    for (const kind of ENTITY_KINDS) this.peak[kind] = Math.max(this.peak[kind], sizes[kind]);
    return out;
  }

  private build(c: Command): ModelPatch[] {
    const districtIds = [...this.districts.keys()];
    const anyDistrict = (k: number) => (districtIds.length ? districtIds[k % districtIds.length] : '');
    const unitIdsNow = [...this.units.keys()];
    const anyUnit = (k: number) => (unitIdsNow.length ? unitIdsNow[k % unitIdsNow.length] : '');
    switch (c.type) {
      case 'city': {
        const id = `c${this.seq++}`;
        this.cities.push(id);
        return [{ op: 'add', kind: 'city', rows: { ids: [id], cols: { name: [`city ${id}`] } } }];
      }
      case 'district': {
        if (!this.cities.length) return this.build({ ...c, type: 'city' });
        const id = `d${this.seq++}`, city = this.cities[c.a % this.cities.length];
        this.districts.set(id, city);
        return [{ op: 'add', kind: 'district', rows: { ids: [id], cols: { city: [city], name: [id] } } }];
      }
      case 'updateDistrict': {
        const [id] = this.some(this.districts.keys(), c.a, 1);
        if (id === undefined) return [];
        const city = this.cities[c.b % this.cities.length];
        this.districts.set(id, city);
        return [{ op: 'update', kind: 'district', rows: { ids: [id], cols: { city: [city], name: [`renamed ${c.b}`] } } }];
      }
      case 'units': {
        const ids: string[] = [], district: string[] = [], loc: number[] = [];
        for (let k = 0; k < c.n; k++) {
          // now and then an id that was removed earlier comes back
          const id = k === 0 && c.b % 3 === 0 && this.removedUnits.length ? this.removedUnits.pop()! : `src/f${this.seq++}.ts`;
          const d = (c.a + k) % 3 ? anyDistrict(c.b + k) : '';
          ids.push(id); district.push(d); loc.push(10 + c.a + k);
          this.units.set(id, d);
        }
        const out: ModelPatch[] = [{ op: 'add', kind: 'unit', rows: { ids, cols: { primaryFile: ids, loc, district } } }];
        const fresh = ids.filter((id) => !this.files.has(id)), kept = ids.filter((id) => this.files.has(id));
        if (fresh.length) out.push({ op: 'add', kind: 'file', rows: { ids: fresh, cols: { unit: fresh, loc: fresh.map((id) => loc[ids.indexOf(id)]) } } });
        if (kept.length) out.push({ op: 'update', kind: 'file', rows: { ids: kept, cols: { unit: kept } } }); // its file outlived it
        ids.forEach((id) => this.files.set(id, id));
        return out;
      }
      case 'edges': {
        const ids: string[] = [], src: string[] = [], dst: string[] = [];
        for (let k = 0; k < c.n && unitIdsNow.length; k++) {
          const s = unitIdsNow[(c.a + k) % unitIdsNow.length], d = unitIdsNow[(c.b + 7 * k) % unitIdsNow.length];
          const id = edgeId(s, d);
          if (this.edges.has(id)) continue;
          this.edges.set(id, [s, d]);
          ids.push(id); src.push(s); dst.push(d);
        }
        return ids.length ? [{ op: 'add', kind: 'edge', rows: { ids, cols: { src, dst, weight: ids.map(() => 1 + c.x) } } }] : [];
      }
      case 'updateEdges': {
        const ids = this.some(this.edges.keys(), c.a, c.n);
        if (!ids.length) return [];
        if (c.b % 5 === 0) ids.push(ids[0]);
        const cols: { weight: number[]; kind: EdgeKind[]; dst?: string[] } = { weight: ids.map((_, k) => 1 + c.x + k), kind: ids.map((_, k) => EDGE_KINDS[(c.b + k) % EDGE_KINDS.length]) };
        if (c.b % 2) {
          // re-point the dependency: the store does not tie an edge's id to its endpoints
          cols.dst = ids.map((_, k) => anyUnit(c.b + k));
          ids.forEach((id, k) => this.edges.set(id, [this.edges.get(id)![0], cols.dst![k]]));
        }
        return [{ op: 'update', kind: 'edge', rows: { ids, cols } }];
      }
      case 'updateUnits': {
        const ids = this.some(this.units.keys(), c.a, c.n);
        if (!ids.length) return [];
        if (c.b % 5 === 0) ids.push(ids[0]); // the same row twice: the later values win
        const cols: { loc: number[]; importancePct: number[]; district?: string[] } = { loc: ids.map((_, k) => c.b + k), importancePct: ids.map(() => c.x) };
        if (c.a % 2) {
          cols.district = ids.map((_, k) => anyDistrict(c.b + k));
          ids.forEach((id, k) => this.units.set(id, cols.district![k]));
        }
        return [{ op: 'update', kind: 'unit', rows: { ids, cols } }];
      }
      case 'updateFiles': {
        const ids = this.some(this.files.keys(), c.a, c.n);
        if (!ids.length) return [];
        const unit = ids.map((_, k) => ((c.b + k) % 3 ? anyUnit(c.b + k) : ''));
        ids.forEach((id, k) => this.files.set(id, unit[k]));
        return [{ op: 'update', kind: 'file', rows: { ids, cols: { unit, bytes: ids.map((_, k) => c.a + k) } } }];
      }
      case 'removeFiles': {
        const ids = this.some(this.files.keys(), c.a, c.n);
        ids.forEach((id) => this.files.delete(id));
        return ids.length ? [{ op: 'remove', kind: 'file', rows: { ids, cols: {} } }] : [];
      }
      case 'assign': {
        const unitIds = this.some(this.units.keys(), c.a, c.n);
        if (!unitIds.length) return [];
        if (c.b % 5 === 0) unitIds.push(unitIds[0]);
        const to = unitIds.map((_, k) => anyDistrict(c.b + k));
        unitIds.forEach((id, k) => this.units.set(id, to[k]));
        return [{ op: 'assign', unitIds, districtIds: to }];
      }
      case 'removeEdges': {
        const ids = this.some(this.edges.keys(), c.a, c.n);
        ids.forEach((id) => this.edges.delete(id));
        return ids.length ? [{ op: 'remove', kind: 'edge', rows: { ids, cols: {} } }] : [];
      }
      case 'removeUnits': {
        // several at once, from the middle of the table: the holes are what later adds reuse
        const gone = new Set(this.some(this.units.keys(), c.a, c.n));
        if (!gone.size) return [];
        const out: ModelPatch[] = [];
        const edges = [...this.edges].filter(([, [s, d]]) => gone.has(s) || gone.has(d)).map(([id]) => id);
        if (edges.length) out.push({ op: 'remove', kind: 'edge', rows: { ids: edges, cols: {} } });
        edges.forEach((id) => this.edges.delete(id));
        const files = [...this.files].filter(([, u]) => gone.has(u)).map(([id]) => id);
        if (files.length && c.b % 2) {
          // re-point the files instead of removing them
          out.push({ op: 'update', kind: 'file', rows: { ids: files, cols: { unit: files.map(() => '') } } });
          files.forEach((id) => this.files.set(id, ''));
        } else if (files.length) {
          out.push({ op: 'remove', kind: 'file', rows: { ids: files, cols: {} } });
          files.forEach((id) => this.files.delete(id));
        }
        out.push({ op: 'remove', kind: 'unit', rows: { ids: [...gone], cols: {} } });
        for (const id of gone) { this.units.delete(id); this.removedUnits.push(id); }
        return out;
      }
      case 'removeDistrict': {
        const [district] = this.some(this.districts.keys(), c.a, 1);
        if (district === undefined) return [];
        const out: ModelPatch[] = [];
        const members = [...this.units].filter(([, d]) => d === district).map(([id]) => id);
        const others = districtIds.filter((d) => d !== district);
        const to = others.length && c.b % 2 ? others[c.b % others.length] : '';
        if (members.length) out.push({ op: 'assign', unitIds: members, districtIds: members.map(() => to) });
        members.forEach((id) => this.units.set(id, to));
        out.push({ op: 'remove', kind: 'district', rows: { ids: [district], cols: {} } });
        const city = this.districts.get(district)!;
        this.districts.delete(district);
        if (c.a % 2 && ![...this.districts.values()].includes(city)) {
          out.push({ op: 'remove', kind: 'city', rows: { ids: [city], cols: {} } });
          this.cities = this.cities.filter((id) => id !== city);
        }
        return out;
      }
      case 'contributor': {
        const [known] = this.some(this.contributors, c.a, 1);
        if (known !== undefined && c.b % 3 === 0) {
          this.contributors.delete(known);
          return [{ op: 'remove', kind: 'contributor', rows: { ids: [known], cols: {} } }];
        }
        if (known !== undefined && c.b % 3 === 1) return [{ op: 'update', kind: 'contributor', rows: { ids: [known], cols: { commits: [c.b] } } }];
        const id = `p${this.seq++}`;
        this.contributors.add(id);
        return [{ op: 'add', kind: 'contributor', rows: { ids: [id], cols: { name: [`Person ${id}`], commits: [c.a] } } }];
      }
      case 'layer': {
        const id = `layer${c.a % 2}`;
        const unitIds = this.some(this.units.keys(), c.b, c.n);
        const op: ModelPatch = { op: 'layer', id, unitIds, values: unitIds.map((_, k) => ((c.b + k) % 4 ? c.x : NaN)), status: STATUSES[c.a % 3], coverage: c.x };
        if (!this.layers.has(id) || c.b % 3 === 0) op.def = layerDef(id);
        if (c.b % 4 === 1) op.extra = { [`key${c.a % 3}`]: c.b }; // merged into what the layer already carries
        this.layers.add(id);
        return [op];
      }
      case 'annotation': {
        const id = `a${c.a % 3}`, parent = `u:${anyUnit(c.b) || 'nothing/yet.ts'}` as const;
        const value: Annotation = c.b % 3 === 0 ? { type: 'poi', id, parent, label: `label ${c.b}`, summary: 'why it matters', kind: 'core', evidence: 'seen', details: {} }
          : c.b % 3 === 1 ? { type: 'summary', id, parent, text: `text ${c.b}` }
            : { type: 'tour', id, steps: [{ parent, frame: 'file', text: `step ${c.b}`, highlights: [parent] }] };
        const key = `${value.type}:${id}`;
        this.annotations.delete(key); // setting one again moves it to the end
        if (c.n === 1) return [{ op: 'annotation', action: 'remove', value }]; // removing one that is not there is allowed
        this.annotations.set(key, value);
        return [c.n === 2 ? { op: 'annotation', action: 'set', value } : { op: 'annotation', value }];
      }
      case 'meta': {
        const value: Partial<RepoMeta> = c.b % 2 ? { name: `repo ${c.a}` } : { parsedAt: c.a, structure: c.b % 4 ? 'full' : 'imports-only' };
        this.meta = { ...this.meta, ...value };
        return [{ op: 'meta', value }];
      }
      case 'progress':
        return [c.b % 2 ? { op: 'progress', subsystem: 'fastPass', done: c.a, total: 1000, label: 'parsing' } : { op: 'progress', subsystem: 'history', done: c.a, total: 1000 }];
      default:
        throw new Error(`unknown command ${c.type}`);
    }
  }
}

const command: fc.Arbitrary<Command> = fc.record({
  type: fc.constantFrom(
    'city', 'district', 'updateDistrict', 'units', 'units', 'units', 'edges', 'edges', 'updateEdges', 'updateUnits', 'updateFiles', 'removeFiles',
    'assign', 'removeEdges', 'removeUnits', 'removeUnits', 'removeDistrict', 'contributor', 'layer', 'layer', 'annotation', 'meta', 'progress',
  ),
  a: fc.nat(1000),
  b: fc.nat(1000),
  n: fc.integer({ min: 1, max: 4 }),
  x: fc.double({ min: 0, max: 1, noNaN: true }).map((v) => Math.fround(v)),
});

/** Operations that are invalid whatever the model holds. */
const ALWAYS_INVALID: ModelPatch[] = [
  { op: 'update', kind: 'city', rows: { ids: ['no such city'], cols: { name: ['x'] } } },
  { op: 'add', kind: 'unit', rows: { ids: ['twice.ts', 'twice.ts'], cols: {} } },
  { op: 'layer', id: 'never-defined', unitIds: [], values: [] },
  { op: 'assign', unitIds: ['no such unit'], districtIds: [''] },
  { op: 'remove', kind: 'contributor', rows: { ids: ['nobody'], cols: {} } },
  { op: 'add', kind: 'edge', rows: { ids: ['dangling'], cols: { src: ['no such unit'], dst: ['no such unit'] } } },
];

/** The checks PLAN.md §5.1 lists for development builds: every reference column points at a live row. */
function expectReferencesLive(replica: ModelReplica): void {
  for (const kind of ENTITY_KINDS) {
    const table = replica.table(kind);
    const refs = REFERENCE_COLUMNS[kind] as Record<string, { kind: EntityKind; optional: boolean }>;
    for (const [col, ref] of Object.entries(refs)) {
      const target = replica.table(ref.kind);
      const ids = (table.cols as unknown as Record<string, string[]>)[col];
      for (const s of table.slots()) {
        const want = ids[s] === '' ? -1 : target.slotOf(ids[s]);
        expect(table.refSlots[col][s], `${kind}.${col} of ${table.ids[s]}`).toBe(want);
        if (!ref.optional) expect(want).toBeGreaterThanOrEqual(0);
      }
    }
  }
}

describe('ModelStore', () => {
  it('batches applied one by one equal a rebuild from the full batch', () => {
    const proposal = fc.record({ commands: fc.array(command, { minLength: 1, maxLength: 6 }), rejectedFirst: fc.option(fc.nat(ALWAYS_INVALID.length - 1), { nil: undefined }) });
    const run = fc.record({ proposals: fc.array(proposal, { minLength: 1, maxLength: 14 }), joinAt: fc.nat(13) });
    fc.assert(fc.property(run, ({ proposals, joinAt }) => {
      const store = createModelStore();
      const follower = createReplica();   // sees every batch as emitted
      const wire = createReplica();       // sees a structured clone of every batch, as a worker would
      let late: ModelReplica | null = null; // joins part-way from a full batch, then follows
      /** Where every live row sits, from the emitted batches alone. */
      const slotOf: Record<EntityKind, Map<string, number>> = { city: new Map(), district: new Map(), unit: new Map(), file: new Map(), edge: new Map(), contributor: new Map() };
      store.subscribe((batch) => {
        expect(batch.baseRev).toBe(batch.rev - 1);
        for (const op of batch.ops) {
          if (op.op === 'add' || op.op === 'update' || op.op === 'remove') {
            const known = slotOf[op.kind], slots = op.rows.slots!;
            expect(slots).toHaveLength(op.rows.ids.length);
            op.rows.ids.forEach((id, r) => {
              if (op.op === 'add') {
                expect([...known.values()], `${op.kind} slot ${slots[r]} is taken`).not.toContain(slots[r]);
                known.set(id, slots[r]);
              } else {
                expect(known.get(id), `${op.op} ${op.kind} ${id}`).toBe(slots[r]); // a row keeps its slot for as long as it lives
                if (op.op === 'remove') known.delete(id);
              }
            });
          } else if (op.op === 'assign') {
            expect(op.units).toEqual(op.unitIds.map((id) => slotOf.unit.get(id)));
            expect(op.districts).toEqual(op.districtIds.map((id) => (id === '' ? -1 : slotOf.district.get(id))));
          } else if (op.op === 'layer') {
            expect(op.slots).toEqual(op.unitIds.map((id) => slotOf.unit.get(id)));
          }
        }
        if (!follower.apply(batch)) throw new Error('the follower saw a revision gap');
        if (!wire.apply(structuredClone(batch))) throw new Error('the wire follower saw a revision gap');
        if (late && !late.apply(batch)) throw new Error('the late follower saw a revision gap');
      });
      const scenario = new Scenario();
      proposals.forEach(({ commands, rejectedFirst }, index) => {
        if (index === joinAt % proposals.length) {
          late = createReplica();
          expect(late.apply(store.fullBatch())).toBe(true);
        }
        const ops = commands.flatMap((c) => scenario.ops(c));
        // A proposal that fails at its last operation must leave nothing behind: the same
        // operations without the bad one then go through as if it had never been tried.
        if (rejectedFirst !== undefined) expect(() => store.propose([...ops, ALWAYS_INVALID[rejectedFirst]])).toThrow(ProposalError);
        store.propose(ops);
        const rebuilt = createReplica();
        expect(rebuilt.apply(store.fullBatch())).toBe(true);
        const expected = view(rebuilt);
        expect(view(follower)).toEqual(expected);
        expect(view(store.replica)).toEqual(expected);
        expect(view(wire)).toEqual(expected);
        if (late) expect(view(late)).toEqual(expected);
        expect(follower.rev).toBe(store.rev);
        expectReferencesLive(follower);
        const sizes = scenario.sizes();
        for (const kind of ENTITY_KINDS) {
          const table = follower.table(kind);
          expect(table.count, kind).toBe(sizes[kind]);
          expect(table.count).toBe(slotOf[kind].size);
          for (const [id, slot] of slotOf[kind]) expect(table.slotOf(id)).toBe(slot);
          // holes are filled before a table grows, so it is never larger than its fullest moment
          expect(store.replica.table(kind).capacity, `${kind} capacity`).toBeLessThanOrEqual(scenario.peak[kind]);
        }
        // an empty unit slot holds no layer value, so a unit that reuses the slot does not inherit one
        const unitTable = follower.table('unit');
        for (const layer of follower.layers.values()) {
          expect(layer.values).toHaveLength(unitTable.capacity);
          for (let s = 0; s < unitTable.capacity; s++) if (unitTable.ids[s] === null) expect(layer.values[s]).toBeNaN();
        }
        expect(follower.meta).toEqual(scenario.meta);
        expect(follower.annotations).toEqual([...scenario.annotations.values()]);
        expect([...follower.layers.keys()].sort()).toEqual([...scenario.layers].sort());
      });
      // whatever the history, something that is still pointed at cannot be removed
      const inUse: [kind: 'city' | 'district' | 'unit', ids: Iterable<string>][] = [
        ['city', scenario.districts.values()],
        ['district', scenario.units.values()],
        ['unit', [...scenario.files.values(), ...[...scenario.edges.values()].flat()]],
      ];
      for (const [kind, ids] of inUse) {
        for (const id of new Set(ids)) {
          if (id !== '') expect(() => store.propose([{ op: 'remove', kind, rows: { ids: [id], cols: {} } }]), `${kind} ${id}`).toThrow(ProposalError);
        }
      }
      // saving and loading keeps everything but the slots: a loaded store is compact
      if (store.replica.meta) {
        const saved = store.toModel();
        const loaded = createModelStore();
        loaded.load(structuredClone(saved));
        expect(loaded.toModel()).toEqual(saved);
        for (const kind of ENTITY_KINDS) expect(loaded.replica.table(kind).capacity).toBe(store.replica.table(kind).count);
        expectReferencesLive(loaded.replica);
      }
    }), { numRuns: 150 });
  });

  it('a replica that misses a batch refuses the next one and resyncs from a full batch', () => {
    const store = createModelStore();
    const batches: PatchBatch[] = [];
    store.subscribe((b) => batches.push(b));
    const tables = syntheticTables({ files: 30, seed: 4 });
    store.propose([{ op: 'meta', value: syntheticMeta('gap', tables) }, ...tablesToOps(tables)]);
    store.propose([{ op: 'update', kind: 'unit', rows: { ids: [tables.unit.ids[0]], cols: { loc: [1234] } } }]);
    store.propose([{ op: 'remove', kind: 'edge', rows: { ids: [tables.edge.ids[0]], cols: {} } }]);

    const replica = createReplica();
    expect(replica.apply(batches[0])).toBe(true);
    const before = view(replica);
    expect(replica.apply(batches[2])).toBe(false);
    expect(replica.rev).toBe(batches[0].rev);
    expect(view(replica)).toEqual(before);

    expect(replica.apply(store.fullBatch())).toBe(true);
    expect(replica.rev).toBe(store.rev);
    expect(view(replica)).toEqual(view(store.replica));
  });

  it('rejects invalid proposals whole, leaving no trace', () => {
    const store = createModelStore();
    const tables = syntheticTables({ files: 40, seed: 5 });
    const units = tables.unit.ids;
    store.propose([
      { op: 'meta', value: syntheticMeta('invalid', tables) },
      ...tablesToOps(tables),
      { op: 'layer', id: 'recency', def: layerDef('recency'), unitIds: units.slice(0, 10), values: units.slice(0, 10).map((_, k) => k / 10) },
    ]);
    // free a slot in the middle, so slot reuse is part of what must be put back
    const loneUnit = 'lone/unit.ts';
    store.propose([
      { op: 'add', kind: 'unit', rows: { ids: [loneUnit, 'lone/other.ts'], cols: {} } },
      { op: 'layer', id: 'recency', unitIds: ['lone/other.ts'], values: [0.25] },
    ]);
    store.propose([{ op: 'remove', kind: 'unit', rows: { ids: [loneUnit], cols: {} } }]);

    const rev = store.rev;
    const before = store.fullBatch();
    const viewBefore = view(store.replica);
    const unitCapacity = store.replica.table('unit').capacity;
    let notified = 0;
    store.subscribe(() => notified++);

    // Valid work of every kind; each case appends one invalid operation to it.
    const valid: ModelPatch[] = [
      { op: 'add', kind: 'city', rows: { ids: ['new-city'], cols: { name: ['New'] } } },
      { op: 'add', kind: 'district', rows: { ids: ['new-district'], cols: { city: ['new-city'], name: ['New'] } } },
      { op: 'add', kind: 'unit', rows: { ids: ['new/a.ts', 'new/b.ts'], cols: { district: ['new-district', ''], loc: [5, 6] } } },
      { op: 'update', kind: 'unit', rows: { ids: [units[1], units[2]], cols: { loc: [9999, 8888], district: ['new-district', 'new-district'] } } },
      { op: 'assign', unitIds: [units[3]], districtIds: ['new-district'] },
      { op: 'layer', id: 'recency', unitIds: [units[0], 'new/a.ts'], values: [0.99, 0.5], status: 'complete' },
      { op: 'layer', id: 'fresh', def: layerDef('fresh'), unitIds: [units[4]], values: [1] },
      { op: 'remove', kind: 'edge', rows: { ids: tables.edge.ids.slice(0, 3), cols: {} } },
      { op: 'annotation', value: { type: 'summary', id: 's1', parent: `u:${units[0]}`, text: 'hello' } },
      { op: 'meta', value: { name: 'renamed' } },
      { op: 'remove', kind: 'unit', rows: { ids: ['lone/other.ts'], cols: {} } },                                        // takes its layer value with it
      { op: 'layer', id: 'recency', unitIds: [units[5], units[5]], values: [0.1, 0.2], extra: { note: 'twice' } },       // same unit twice
    ];
    const invalid: ModelPatch[] = [
      { op: 'add', kind: 'city', rows: { ids: ['new-city'], cols: { name: ['again'] } } },                               // duplicate id
      { op: 'add', kind: 'unit', rows: { ids: ['twice.ts', 'twice.ts'], cols: {} } },                                    // duplicate inside one chunk
      { op: 'add', kind: 'edge', rows: { ids: [edgeId('new/a.ts', 'nowhere')], cols: { src: ['new/a.ts'], dst: ['nowhere'] } } }, // reference does not resolve
      { op: 'remove', kind: 'unit', rows: { ids: [units[0]], cols: {} } },                                               // still referenced
      { op: 'update', kind: 'unit', rows: { ids: [units[0], units[1]], cols: { loc: [1] } } },                           // column too short
      { op: 'update', kind: 'unit', rows: { ids: [units[0]], cols: { loc: ['big'] as unknown as number[] } } },          // wrong type
      { op: 'update', kind: 'file', rows: { ids: ['no/such/file.ts'], cols: { loc: [1] } } },                            // unknown id
      { op: 'assign', unitIds: [units[0]], districtIds: ['no-such-district'] },
      { op: 'layer', id: 'undefined-layer', unitIds: [units[0]], values: [1] },                                          // first patch without def
    ];
    for (const bad of invalid) {
      let error: unknown;
      try { store.propose([...valid, bad]); } catch (e) { error = e; }
      expect(error, JSON.stringify(bad)).toBeInstanceOf(ProposalError);
      expect((error as ProposalError).opIndex).toBe(valid.length);
      expect(store.rev).toBe(rev);
      expect(store.fullBatch()).toEqual(before);
      expect(view(store.replica)).toEqual(viewBefore);
      expect(store.replica.table('unit').capacity).toBe(unitCapacity);
    }
    expect(notified).toBe(0);

    // The valid part on its own goes through, and the freed slot is the first one reused.
    const freed = units.length; // loneUnit was appended right after the synthetic units
    const applied = store.propose(valid);
    expect(applied.rev).toBe(rev + 1);
    expect(notified).toBe(1);
    const addUnits = applied.ops[2];
    expect(addUnits.op === 'add' && addUnits.rows.slots).toEqual([freed, unitCapacity]);
    const follower = createReplica();
    follower.apply(store.fullBatch());
    expect(view(follower)).toEqual(view(store.replica));
  });
});
