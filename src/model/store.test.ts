import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ProposalError } from '../contracts/store';
import { syntheticMeta, syntheticTables, tablesToOps } from '../testing/synthetic';
import { createModelStore, createReplica, edgeId, type LayerDef, type ModelPatch, type PatchBatch } from './index';
import { view } from './testHelpers';

const layerDef = (id: string): LayerDef => ({ id, kind: 'scalar', label: id, domain: [0, 1], colormap: 'viridis' });

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
  layers = new Set<string>();

  private some<T>(from: Iterable<T>, start: number, count: number): T[] {
    const all = [...from];
    const out: T[] = [];
    for (let k = 0; k < Math.min(count, all.length); k++) out.push(all[(start + k) % all.length]);
    return out;
  }

  ops(c: Command): ModelPatch[] {
    const districtIds = [...this.districts.keys()];
    const anyDistrict = (k: number) => (districtIds.length ? districtIds[k % districtIds.length] : '');
    switch (c.type) {
      case 'city': {
        const id = `c${this.seq++}`;
        this.cities.push(id);
        return [{ op: 'add', kind: 'city', rows: { ids: [id], cols: { name: [`city ${id}`] } } }];
      }
      case 'district': {
        if (!this.cities.length) return this.ops({ ...c, type: 'city' });
        const id = `d${this.seq++}`, city = this.cities[c.a % this.cities.length];
        this.districts.set(id, city);
        return [{ op: 'add', kind: 'district', rows: { ids: [id], cols: { city: [city], name: [id] } } }];
      }
      case 'units': {
        const ids: string[] = [], district: string[] = [], loc: number[] = [];
        for (let k = 0; k < c.n; k++) {
          const id = `src/f${this.seq++}.ts`;
          const d = (c.a + k) % 3 ? anyDistrict(c.b + k) : '';
          ids.push(id); district.push(d); loc.push(10 + c.a + k);
          this.units.set(id, d);
          this.files.set(id, id);
        }
        return [
          { op: 'add', kind: 'unit', rows: { ids, cols: { primaryFile: ids, loc, district } } },
          { op: 'add', kind: 'file', rows: { ids, cols: { unit: ids, loc } } },
        ];
      }
      case 'edges': {
        const unitIds = [...this.units.keys()];
        const ids: string[] = [], src: string[] = [], dst: string[] = [];
        for (let k = 0; k < c.n && unitIds.length; k++) {
          const s = unitIds[(c.a + k) % unitIds.length], d = unitIds[(c.b + 7 * k) % unitIds.length];
          const id = edgeId(s, d);
          if (this.edges.has(id)) continue;
          this.edges.set(id, [s, d]);
          ids.push(id); src.push(s); dst.push(d);
        }
        return ids.length ? [{ op: 'add', kind: 'edge', rows: { ids, cols: { src, dst, weight: ids.map(() => 1 + c.x) } } }] : [];
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
      case 'removeUnit': {
        const [unit] = this.some(this.units.keys(), c.a, 1);
        if (unit === undefined) return [];
        const out: ModelPatch[] = [];
        const edges = [...this.edges].filter(([, [s, d]]) => s === unit || d === unit).map(([id]) => id);
        if (edges.length) out.push({ op: 'remove', kind: 'edge', rows: { ids: edges, cols: {} } });
        edges.forEach((id) => this.edges.delete(id));
        const files = [...this.files].filter(([, u]) => u === unit).map(([id]) => id);
        if (files.length && c.b % 2) {
          // re-point the files instead of removing them
          out.push({ op: 'update', kind: 'file', rows: { ids: files, cols: { unit: files.map(() => '') } } });
          files.forEach((id) => this.files.set(id, ''));
        } else if (files.length) {
          out.push({ op: 'remove', kind: 'file', rows: { ids: files, cols: {} } });
          files.forEach((id) => this.files.delete(id));
        }
        out.push({ op: 'remove', kind: 'unit', rows: { ids: [unit], cols: {} } });
        this.units.delete(unit);
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
      case 'layer': {
        const id = `layer${c.a % 2}`;
        const unitIds = this.some(this.units.keys(), c.b, c.n);
        const op: ModelPatch = { op: 'layer', id, unitIds, values: unitIds.map((_, k) => ((c.b + k) % 4 ? c.x : NaN)), status: 'partial', coverage: c.x };
        if (!this.layers.has(id) || c.b % 3 === 0) op.def = layerDef(id);
        this.layers.add(id);
        return [op];
      }
      default:
        throw new Error(`unknown command ${c.type}`);
    }
  }
}

const command: fc.Arbitrary<Command> = fc.record({
  type: fc.constantFrom('city', 'district', 'units', 'units', 'edges', 'edges', 'updateUnits', 'assign', 'removeEdges', 'removeUnit', 'removeDistrict', 'layer'),
  a: fc.nat(1000),
  b: fc.nat(1000),
  n: fc.integer({ min: 1, max: 4 }),
  x: fc.double({ min: 0, max: 1, noNaN: true }).map((v) => Math.fround(v)),
});

describe('ModelStore', () => {
  it('batches applied one by one equal a rebuild from the full batch', () => {
    const proposal = fc.record({ commands: fc.array(command, { minLength: 1, maxLength: 6 }), rejectedFirst: fc.boolean() });
    const invalid: ModelPatch = { op: 'update', kind: 'city', rows: { ids: ['no such city'], cols: { name: ['x'] } } };
    fc.assert(fc.property(fc.array(proposal, { minLength: 1, maxLength: 12 }), (proposals) => {
      const store = createModelStore();
      const follower = createReplica();
      store.subscribe((batch) => { if (!follower.apply(batch)) throw new Error('the follower saw a revision gap'); });
      const scenario = new Scenario();
      for (const { commands, rejectedFirst } of proposals) {
        const ops = commands.flatMap((c) => scenario.ops(c));
        // A proposal that fails at its last operation must leave nothing behind: the same
        // operations without the bad one then go through as if it had never been tried.
        if (rejectedFirst) expect(() => store.propose([...ops, invalid])).toThrow(ProposalError);
        store.propose(ops);
        const rebuilt = createReplica();
        expect(rebuilt.apply(store.fullBatch())).toBe(true);
        expect(view(follower)).toEqual(view(rebuilt));
        expect(view(store.replica)).toEqual(view(rebuilt));
        expect(follower.rev).toBe(store.rev);
        // an empty unit slot holds no layer value, so a unit that reuses the slot does not inherit one
        const unitTable = follower.table('unit');
        for (const layer of follower.layers.values()) {
          expect(layer.values).toHaveLength(unitTable.capacity);
          for (let s = 0; s < unitTable.capacity; s++) if (unitTable.ids[s] === null) expect(layer.values[s]).toBeNaN();
        }
      }
      expect(store.replica.table('unit').count).toBe(scenario.units.size);
      expect(store.replica.table('file').count).toBe(scenario.files.size);
      expect(store.replica.table('edge').count).toBe(scenario.edges.size);
      expect(store.replica.table('district').count).toBe(scenario.districts.size);
      expect(store.replica.table('city').count).toBe(scenario.cities.length);
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
    }), { numRuns: 80 });
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
