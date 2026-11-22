// What the store refuses, reason by reason, and how it delivers what it accepts (PLAN.md §5.1 rule 1;
// the store's own choices are listed at the top of store.ts).
import { describe, expect, it } from 'vitest';
import { ProposalError } from '../contracts/store';
import { syntheticMeta, syntheticTables, tablesToOps } from '../testing/synthetic';
import { createModelStore, createReplica, edgeId, ENTITY_KINDS, type LayerDef, type ModelPatch, type PatchBatch } from './index';
import { view } from './testHelpers';

const layerDef = (id: string, over: Partial<LayerDef> = {}): LayerDef => ({ id, kind: 'scalar', label: id, domain: [0, 1], colormap: 'viridis', ...over });
/** An operation that TypeScript would not let a producer write, as it could still arrive from a worker. */
const raw = (op: unknown): ModelPatch => op as ModelPatch;

/** A small model with every kind of thing in it, and holes in the unit and edge tables. */
function seeded() {
  const store = createModelStore();
  const tables = syntheticTables({ files: 24, cities: 2, districtsPerCity: 2, seed: 9 });
  const units = tables.unit.ids;
  store.propose([
    { op: 'meta', value: syntheticMeta('rejections', tables) },
    ...tablesToOps(tables),
    { op: 'add', kind: 'contributor', rows: { ids: ['ann'], cols: { name: ['Ann'], commits: [3] } } },
    { op: 'add', kind: 'unit', rows: { ids: ['free/a.ts', 'free/b.ts', 'free/c.ts'], cols: {} } },
    { op: 'layer', id: 'recency', def: layerDef('recency'), unitIds: [units[0], units[1], 'free/b.ts'], values: [0.1, 0.2, 0.3], status: 'partial', coverage: 0.5, extra: { note: 1 } },
    { op: 'annotation', value: { type: 'summary', id: 's0', parent: `u:${units[0]}`, text: 'kept' } },
  ]);
  store.propose([{ op: 'remove', kind: 'unit', rows: { ids: ['free/a.ts', 'free/c.ts'], cols: {} } }]);
  return { store, tables, units };
}

describe('ModelStore: what a proposal may not contain', () => {
  const { tables, units } = seeded(); // every store built by seeded() holds the same rows
  const u0 = units[0], u1 = units[1];
  const district = tables.district.ids[0], city = tables.city.ids[0];
  const edge = tables.edge.ids[0];
  // a district that has units, a city that has districts, a unit that has a file and an edge
  const fullDistrict = tables.unit.cols.district![0];
  const edgeSrc = tables.edge.cols.src![0];

  /** Valid work of several kinds that every case puts in front of its invalid operation. */
  const prefix: ModelPatch[] = [
    { op: 'add', kind: 'city', rows: { ids: ['px-city'], cols: { name: ['P'] } } },
    { op: 'add', kind: 'district', rows: { ids: ['px-district'], cols: { city: ['px-city'], name: ['P'] } } },
    { op: 'add', kind: 'unit', rows: { ids: ['px/a.ts', 'px/b.ts', 'px/c.ts'], cols: { district: ['px-district', '', district], loc: [1, 2, 3] } } },
    { op: 'add', kind: 'file', rows: { ids: ['px/a.ts'], cols: { unit: ['px/a.ts'] } } },
    { op: 'add', kind: 'edge', rows: { ids: [edgeId('px/a.ts', u0)], cols: { src: ['px/a.ts'], dst: [u0], kind: ['call'] } } },
    { op: 'update', kind: 'unit', rows: { ids: [u0, u1, u0], cols: { loc: [7, 8, 9], district: ['px-district', '', 'px-district'] } } },
    { op: 'assign', unitIds: [u1, 'free/b.ts'], districtIds: ['px-district', district] },
    { op: 'layer', id: 'recency', unitIds: [u0, 'px/b.ts', u0], values: [0.9, NaN, 0.8], status: 'complete', coverage: 1, extra: { more: [1, 2] } },
    { op: 'layer', id: 'px-layer', def: layerDef('px-layer', { kind: 'categorical' }), unitIds: ['px/c.ts'], values: [2] },
    { op: 'remove', kind: 'edge', rows: { ids: [edge], cols: {} } },
    { op: 'remove', kind: 'unit', rows: { ids: ['free/b.ts'], cols: {} } },
    { op: 'annotation', value: { type: 'summary', id: 's0', parent: `u:${u0}`, text: 'replaced' } },
    { op: 'annotation', action: 'remove', value: { type: 'summary', id: 's0', parent: `u:${u0}`, text: '' } },
    { op: 'annotation', value: { type: 'tour', id: 't', steps: [] } },
    { op: 'meta', value: { name: 'renamed', headOid: 'abc' } },
    { op: 'update', kind: 'contributor', rows: { ids: ['ann'], cols: { commits: [4] } } },
    { op: 'progress', subsystem: 'fastPass', done: 1, total: 2 },
  ];

  const circular: Record<string, unknown> = {};
  circular.self = () => circular; // a function cannot be cloned

  /** `after` marks a case that is only wrong because of what the prefix did before it. */
  const cases: [reason: string, bad: ModelPatch, message: RegExp, after?: 'after the prefix'][] = [
    // shape of an operation
    ['not an object', raw(null), /must be an object/],
    ['a string', raw('add'), /must be an object/],
    ['unknown operation', raw({ op: 'rename', kind: 'unit' }), /unknown operation 'rename'/],
    ['unknown entity kind', raw({ op: 'add', kind: 'planet', rows: { ids: ['x'], cols: {} } }), /unknown entity kind 'planet'/],
    ['a kind that is an Object.prototype name', raw({ op: 'add', kind: 'constructor', rows: { ids: ['x'], cols: {} } }), /unknown entity kind/],
    ['rows missing', raw({ op: 'add', kind: 'unit' }), /rows\.ids must be an array/],
    ['ids not an array', raw({ op: 'update', kind: 'unit', rows: { ids: u0, cols: {} } }), /rows\.ids must be an array/],
    ['cols missing', raw({ op: 'add', kind: 'unit', rows: { ids: ['x.ts'] } }), /rows\.cols must be an object/],
    ['cols an array', raw({ op: 'update', kind: 'unit', rows: { ids: [u0], cols: [] } }), /rows\.cols must be an object/],
    // ids
    ['empty id', { op: 'add', kind: 'unit', rows: { ids: ['ok.ts', ''], cols: {} } }, /row 1 has no id/],
    ['id that is not a string', raw({ op: 'add', kind: 'unit', rows: { ids: [42], cols: {} } }), /row 0 has no id/],
    ['add: id exists', { op: 'add', kind: 'unit', rows: { ids: ['new.ts', u0], cols: {} } }, /already exists/],
    ['add: id added earlier in the same proposal', { op: 'add', kind: 'unit', rows: { ids: ['px/a.ts'], cols: {} } }, /'px\/a\.ts' already exists/, 'after the prefix'],
    ['add: id twice in one chunk', { op: 'add', kind: 'contributor', rows: { ids: ['bob', 'cy', 'bob'], cols: {} } }, /'bob' already exists/],
    ['update: unknown id', { op: 'update', kind: 'file', rows: { ids: ['no/such.ts'], cols: { loc: [1] } } }, /'no\/such\.ts' does not exist/],
    ['update: id removed earlier in the same proposal', { op: 'update', kind: 'unit', rows: { ids: ['free/b.ts'], cols: { loc: [1] } } }, /does not exist/, 'after the prefix'],
    ['update: id that was removed long ago', { op: 'update', kind: 'unit', rows: { ids: ['free/a.ts'], cols: { loc: [1] } } }, /does not exist/],
    ['remove: unknown id', { op: 'remove', kind: 'edge', rows: { ids: ['no\tsuch'], cols: {} } }, /does not exist/],
    ['remove: listed twice', { op: 'remove', kind: 'contributor', rows: { ids: ['ann', 'ann'], cols: {} } }, /listed twice/],
    // columns
    ['unknown column', raw({ op: 'update', kind: 'unit', rows: { ids: [u0], cols: { colour: ['red'] } } }), /unknown column 'colour'/],
    ['a column of another kind', raw({ op: 'add', kind: 'city', rows: { ids: ['c'], cols: { loc: [1] } } }), /unknown column 'loc'/],
    ['column not an array', raw({ op: 'update', kind: 'unit', rows: { ids: [u0], cols: { loc: 5 } } }), /column 'loc' must be an array/],
    ['column too short', { op: 'update', kind: 'unit', rows: { ids: [u0, u1], cols: { loc: [1] } } }, /1 values for 2 ids/],
    ['column too long', { op: 'add', kind: 'unit', rows: { ids: ['long.ts'], cols: { loc: [1, 2] } } }, /2 values for 1 ids/],
    ['string in a number column', raw({ op: 'update', kind: 'unit', rows: { ids: [u0], cols: { loc: ['12'] } } }), /must be a finite number, got '12'/],
    ['NaN in a number column', { op: 'update', kind: 'unit', rows: { ids: [u0], cols: { importancePct: [NaN] } } }, /must be a finite number/],
    ['Infinity in a number column', { op: 'add', kind: 'edge', rows: { ids: ['e'], cols: { src: [u0], dst: [u1], weight: [Infinity] } } }, /must be a finite number/],
    ['null in a number column', raw({ op: 'update', kind: 'file', rows: { ids: [u0], cols: { bytes: [null] } } }), /got null/],
    ['number in a string column', raw({ op: 'update', kind: 'unit', rows: { ids: [u0], cols: { lang: [7] } } }), /must be a string/],
    ['edge kind that is not one', raw({ op: 'update', kind: 'edge', rows: { ids: [tables.edge.ids[1]], cols: { kind: ['friend'] } } }), /'friend' is not an edge kind/],
    // references
    ['add edge without src', raw({ op: 'add', kind: 'edge', rows: { ids: ['e'], cols: { dst: [u0] } } }), /column 'src' is required/],
    ['add edge without dst', raw({ op: 'add', kind: 'edge', rows: { ids: ['e'], cols: { src: [u0] } } }), /column 'dst' is required/],
    ['add district without city', { op: 'add', kind: 'district', rows: { ids: ['d'], cols: { name: ['d'] } } }, /column 'city' is required/],
    ['required reference left empty', { op: 'add', kind: 'edge', rows: { ids: ['e'], cols: { src: [u0], dst: [''] } } }, /dst of 'e' is empty/],
    ['district.city emptied by an update', { op: 'update', kind: 'district', rows: { ids: [district], cols: { city: [''] } } }, /city of .* is empty/],
    ['edge to a unit that does not exist', { op: 'add', kind: 'edge', rows: { ids: ['e'], cols: { src: [u0], dst: ['ghost.ts'] } } }, /names unit 'ghost\.ts', which does not exist/],
    ['edge to a unit removed earlier in the same proposal', { op: 'add', kind: 'edge', rows: { ids: ['e'], cols: { src: [u0], dst: ['free/b.ts'] } } }, /does not exist/, 'after the prefix'],
    ['unit in a district that does not exist', { op: 'add', kind: 'unit', rows: { ids: ['n.ts'], cols: { district: ['ghost'] } } }, /names district 'ghost'/],
    ['unit moved to a district that does not exist', { op: 'update', kind: 'unit', rows: { ids: [u0], cols: { district: ['ghost'] } } }, /names district 'ghost'/],
    ['file of a unit that does not exist', { op: 'add', kind: 'file', rows: { ids: ['n.ts'], cols: { unit: ['ghost.ts'] } } }, /names unit 'ghost\.ts'/],
    ['district in a city that does not exist', { op: 'add', kind: 'district', rows: { ids: ['d'], cols: { city: ['ghost'] } } }, /names city 'ghost'/],
    ['a reference to an id of the wrong kind', { op: 'add', kind: 'file', rows: { ids: ['n.ts'], cols: { unit: [district] } } }, /names unit/],
    ['remove a city that has districts', { op: 'remove', kind: 'city', rows: { ids: [city], cols: {} } }, /still referenced/],
    ['remove a district that has units', { op: 'remove', kind: 'district', rows: { ids: [fullDistrict], cols: {} } }, /still referenced/],
    ['remove a unit that has a file and edges', { op: 'remove', kind: 'unit', rows: { ids: [edgeSrc], cols: {} } }, /still referenced/],
    ['remove a unit referenced only by rows added in the same proposal', { op: 'remove', kind: 'unit', rows: { ids: ['px/a.ts'], cols: {} } }, /still referenced by 2 live row/, 'after the prefix'],
    ['remove a district referenced only since the same proposal', { op: 'remove', kind: 'district', rows: { ids: ['px-district'], cols: {} } }, /still referenced/, 'after the prefix'],
    // assign
    ['assign: not arrays', raw({ op: 'assign', unitIds: u0, districtIds: district }), /must be arrays/],
    ['assign: lengths differ', { op: 'assign', unitIds: [u0, u1], districtIds: [district] }, /2 unit ids for 1 district ids/],
    ['assign: unknown unit', { op: 'assign', unitIds: ['ghost.ts'], districtIds: [district] }, /unit 'ghost\.ts' does not exist/],
    ['assign: unknown district', { op: 'assign', unitIds: [u0], districtIds: ['ghost'] }, /district 'ghost' does not exist/],
    ['assign: district id that is not a string', raw({ op: 'assign', unitIds: [u0], districtIds: [null] }), /district 'null' does not exist/],
    ['assign: a city where a district is expected', { op: 'assign', unitIds: [u0], districtIds: [city] }, /does not exist/],
    // layer
    ['layer: empty id', { op: 'layer', id: '', def: layerDef(''), unitIds: [], values: [] }, /id must be a non-empty string/],
    ['layer: values not an array', raw({ op: 'layer', id: 'recency', unitIds: [u0], values: 1 }), /must be arrays/],
    ['layer: lengths differ', { op: 'layer', id: 'recency', unitIds: [u0, u1], values: [1] }, /1 values for 2 unit ids/],
    ['layer: first patch without def', { op: 'layer', id: 'unseen', unitIds: [u0], values: [1] }, /must carry its def/],
    ['layer: def for another layer', { op: 'layer', id: 'recency', def: layerDef('ownership'), unitIds: [], values: [] }, /def\.id is 'ownership'/],
    ['layer: def that is not an object', raw({ op: 'layer', id: 'recency', def: 'scalar', unitIds: [], values: [] }), /def must be an object/],
    ['layer: unknown def.kind', raw({ op: 'layer', id: 'n', def: { ...layerDef('n'), kind: 'vector' }, unitIds: [], values: [] }), /unknown def\.kind 'vector'/],
    ['layer: def without a label', raw({ op: 'layer', id: 'n', def: { ...layerDef('n'), label: undefined }, unitIds: [], values: [] }), /label and def\.colormap must be strings/],
    ['layer: def.domain of one number', raw({ op: 'layer', id: 'n', def: { ...layerDef('n'), domain: [0] }, unitIds: [], values: [] }), /domain must be two finite numbers/],
    ['layer: def.domain not finite', { op: 'layer', id: 'n', def: layerDef('n', { domain: [0, Infinity] }), unitIds: [], values: [] }, /domain must be two finite numbers/],
    ['layer: unknown status', raw({ op: 'layer', id: 'recency', unitIds: [], values: [], status: 'done' }), /unknown status 'done'/],
    ['layer: coverage not finite', { op: 'layer', id: 'recency', unitIds: [], values: [], coverage: NaN }, /coverage must be a finite number/],
    ['layer: extra not an object', raw({ op: 'layer', id: 'recency', unitIds: [], values: [], extra: [1] }), /extra must be an object/],
    ['layer: extra that cannot be cloned', { op: 'layer', id: 'recency', unitIds: [], values: [], extra: circular }, /cannot be cloned/],
    ['layer: unknown unit', { op: 'layer', id: 'recency', unitIds: [u0, 'ghost.ts'], values: [1, 2] }, /unit 'ghost\.ts' does not exist/],
    ['layer: a unit removed earlier in the same proposal', { op: 'layer', id: 'recency', unitIds: ['free/b.ts'], values: [1] }, /does not exist/, 'after the prefix'],
    ['layer: infinite value', { op: 'layer', id: 'recency', unitIds: [u0], values: [-Infinity] }, /must be a finite number or NaN/],
    ['layer: value that is not a number', raw({ op: 'layer', id: 'recency', unitIds: [u0], values: [null] }), /must be a finite number or NaN, got null/],
    // annotation, meta, progress
    ['annotation: unknown type', raw({ op: 'annotation', value: { type: 'note', id: 'n' } }), /value\.type must be/],
    ['annotation: no value', raw({ op: 'annotation' }), /value\.type must be/],
    ['annotation: empty id', raw({ op: 'annotation', value: { type: 'summary', id: '', parent: 'u:x', text: '' } }), /value\.id must be a non-empty string/],
    ['annotation: unknown action', raw({ op: 'annotation', action: 'delete', value: { type: 'tour', id: 't', steps: [] } }), /unknown action 'delete'/],
    ['annotation: cannot be cloned', raw({ op: 'annotation', value: { type: 'tour', id: 't2', steps: [], onClick: () => 0 } }), /cannot be cloned/],
    ['meta: not an object', raw({ op: 'meta', value: 'name' }), /value must be an object/],
    ['meta: cannot be cloned', raw({ op: 'meta', value: { name: () => 'x' } }), /cannot be cloned/],
    ['progress: no subsystem', raw({ op: 'progress', done: 1, total: 2 }), /subsystem must be a string/],
    ['progress: done not finite', { op: 'progress', subsystem: 'history', done: NaN, total: 2 }, /must be finite numbers/],
    ['progress: label not a string', raw({ op: 'progress', subsystem: 'history', done: 1, total: 2, label: 5 }), /label must be a string/],
  ];

  /** Propose `ops`, expecting a rejection at `index` that leaves no trace. */
  function expectRejected(store: ReturnType<typeof createModelStore>, ops: ModelPatch[], index: number, message: RegExp): void {
    const rev = store.rev;
    const before = store.fullBatch();
    const viewBefore = view(store.replica);
    const capacities = ENTITY_KINDS.map((k) => store.replica.table(k).capacity);
    let notified = 0;
    const unsubscribe = store.subscribe(() => notified++);
    let error: unknown;
    try { store.propose(ops); } catch (e) { error = e; }
    unsubscribe();
    expect(error).toBeInstanceOf(ProposalError);
    expect((error as ProposalError).opIndex).toBe(index);
    expect((error as ProposalError).message).toMatch(message);
    expect(notified).toBe(0);
    expect(store.rev).toBe(rev);
    expect(store.replica.rev).toBe(rev);
    expect(ENTITY_KINDS.map((k) => store.replica.table(k).capacity)).toEqual(capacities);
    // compare the cheap way first: a failed toEqual on two whole models prints a very long diff
    expect(JSON.stringify(store.fullBatch()) === JSON.stringify(before), 'the full batch changed').toBe(true);
    expect(view(store.replica)).toEqual(viewBefore);
  }

  it.each(cases)('%s', (_reason, bad, message, after) => {
    const { store } = seeded();
    if (!after) expectRejected(store, [bad], 0, message);
    expectRejected(store, [...prefix, bad], prefix.length, message);
    expectRejected(store, [...prefix, bad, ...prefix], prefix.length, message);
  });

  it('after every one of those rejections in turn, the same valid work still goes through, into the slots that were free', () => {
    const { store } = seeded();
    for (const [, bad, message] of cases) expectRejected(store, [...prefix, bad], prefix.length, message);
    const rev = store.rev;
    const unitCapacity = store.replica.table('unit').capacity;
    const freeUnitSlots = Array.from({ length: unitCapacity }, (_, s) => s).filter((s) => store.replica.table('unit').ids[s] === null);
    expect(freeUnitSlots.length).toBe(2); // free/a.ts and free/c.ts were removed
    const batch = store.propose(prefix);
    expect(batch.rev).toBe(rev + 1);
    const addUnits = batch.ops[2];
    expect(addUnits.op === 'add' && addUnits.rows.slots).toEqual([...freeUnitSlots, unitCapacity]); // holes first, lowest first, then the end
    const rebuilt = createReplica();
    rebuilt.apply(store.fullBatch());
    expect(view(store.replica)).toEqual(view(rebuilt));
    // the unit that took over a freed slot starts with no layer value, and extra was merged
    const recency = store.replica.layers.get('recency')!;
    expect(recency.values[store.replica.table('unit').slotOf('px/a.ts')]).toBeNaN();
    expect(recency.extra).toEqual({ note: 1, more: [1, 2] });
    expect(store.replica.annotations.map((a) => `${a.type}:${a.id}`)).toEqual(['tour:t']);
  });

  it('a proposal that is not a list is refused before any operation is looked at', () => {
    const { store } = seeded();
    for (const bad of [null, undefined, 'ops', { op: 'meta', value: {} }]) {
      let error: unknown;
      try { store.propose(bad as unknown as ModelPatch[]); } catch (e) { error = e; }
      expect(error).toBeInstanceOf(ProposalError);
      expect((error as ProposalError).opIndex).toBe(-1);
    }
  });
});

describe('ModelStore: delivery', () => {
  it('an empty proposal is still one batch and one revision', () => {
    const store = createModelStore();
    const seen: PatchBatch[] = [];
    store.subscribe((b) => seen.push(b));
    expect(store.propose([])).toEqual({ rev: 1, baseRev: 0, ops: [] });
    expect(seen).toHaveLength(1);
    expect(store.rev).toBe(1);
  });

  it('emitted batches own their data: editing the proposal afterwards changes nothing', () => {
    const store = createModelStore();
    const ids = ['a.ts', 'b.ts'], loc = [1, 2];
    const meta = { name: 'before' }, def = layerDef('l'), extra = { deep: { n: 1 } };
    const values = [0.5, 0.25];
    const batch = store.propose([
      { op: 'meta', value: meta },
      { op: 'add', kind: 'unit', rows: { ids, cols: { loc }, slots: [9, 9] } }, // slots in a proposal are ignored
      { op: 'layer', id: 'l', def, unitIds: ids, values, extra },
    ]);
    const before = structuredClone(batch);
    const viewBefore = view(store.replica);
    ids[0] = 'changed.ts'; loc[1] = 99; meta.name = 'after'; def.label = 'changed'; extra.deep.n = 2; values[0] = 1;
    expect(batch).toEqual(before);
    expect(view(store.replica)).toEqual(viewBefore);
    const add = batch.ops[1];
    expect(add.op === 'add' && add.rows.slots).toEqual([0, 1]);
  });

  it('subscribers get batches in revision order, also when one of them proposes from inside its callback', () => {
    const store = createModelStore();
    const first: number[] = [], second: number[] = [];
    const follower = createReplica();
    store.subscribe((b) => {
      first.push(b.rev);
      if (b.rev === 1) store.propose([{ op: 'add', kind: 'city', rows: { ids: ['from-callback'], cols: {} } }]);
    });
    store.subscribe((b) => { second.push(b.rev); expect(follower.apply(b)).toBe(true); });
    const unsubscribed: number[] = [];
    const off = store.subscribe((b) => unsubscribed.push(b.rev));
    off();
    store.propose([{ op: 'add', kind: 'city', rows: { ids: ['outer'], cols: {} } }]);
    expect(first).toEqual([1, 2]);
    expect(second).toEqual([1, 2]);
    expect(unsubscribed).toEqual([]);
    expect(store.rev).toBe(2);
    expect(view(follower)).toEqual(view(store.replica));
    expect(follower.table('city').slotOf('from-callback')).toBe(1);
  });

  it('a subscriber that throws does not stop the others, and the batch stays applied', () => {
    const store = createModelStore();
    const seen: number[] = [];
    store.subscribe(() => { throw new Error('first subscriber failed'); });
    store.subscribe((b) => seen.push(b.rev));
    let error: unknown;
    try { store.propose([{ op: 'add', kind: 'city', rows: { ids: ['c'], cols: {} } }]); } catch (e) { error = e; }
    expect((error as Error).message).toBe('first subscriber failed');
    expect(error).not.toBeInstanceOf(ProposalError);
    expect(seen).toEqual([1]);
    expect(store.rev).toBe(1);
    expect(store.replica.table('city').has('c')).toBe(true);
    // and the store is still usable
    try { store.propose([{ op: 'add', kind: 'city', rows: { ids: ['d'], cols: {} } }]); } catch { /* the same subscriber again */ }
    expect(seen).toEqual([1, 2]);
    expect(store.replica.table('city').count).toBe(2);
  });

  it("the store's own replica notifies its subscribers too, before the store's", () => {
    const store = createModelStore();
    const order: string[] = [];
    store.subscribe((b) => order.push(`store ${b.rev}`));
    store.replica.subscribe((b) => order.push(`replica ${b.rev}`));
    store.propose([]);
    expect(order).toEqual(['replica 1', 'store 1']);
  });
});
