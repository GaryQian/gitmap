import { describe, expect, it } from 'vitest';
import { syntheticMeta, syntheticTables, tablesToOps } from '../testing/synthetic';
import {
  createModelStore, decodeModel, diffStructure, encodeModel,
  type EntityKind, type LayoutSnapshot, type ModelPatch, type RepoModel, type StructureTables,
} from './index';
import { rowsById, view } from './testHelpers';

const STRUCTURE: (keyof StructureTables)[] = ['city', 'district', 'unit', 'file', 'edge'];

async function gzipJson(value: unknown): Promise<Uint8Array> {
  const stream = new Blob([JSON.stringify(value)]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function storeWith(tables: StructureTables, name: string) {
  const store = createModelStore();
  store.propose([{ op: 'meta', value: syntheticMeta(name, tables) }, ...tablesToOps(tables)]);
  return store;
}

describe('snapshot format', () => {
  it('round-trips a model with holes, layers, annotations and a layout; load rebuilds the same tables', async () => {
    const tables = syntheticTables({ files: 80, seed: 3 });
    const store = storeWith(tables, 'snapshot');
    const units = tables.unit.ids;
    const victim = units[7];
    const victimEdges = tables.edge.ids.filter((_, r) => tables.edge.cols.src![r] === victim || tables.edge.cols.dst![r] === victim);
    const ops: ModelPatch[] = [
      { op: 'add', kind: 'contributor', rows: { ids: ['a', 'b', 'c'], cols: { name: ['Ann', 'Ann', 'Cy'], emails: ['x@example.com', 'x@example.com', 'x@example.com'], commits: [12, 12, 3] } } },
      { op: 'layer', id: 'recency', def: { id: 'recency', kind: 'scalar', label: 'Recency', domain: [0, 1], colormap: 'viridis' },
        unitIds: units.slice(0, 20), values: units.slice(0, 20).map((_, k) => (k % 5 ? k / 20 : NaN)), status: 'partial', coverage: 0.2, extra: { authors: { [units[0]]: 3 } } },
      { op: 'annotation', value: { type: 'poi', id: 'p1', parent: `u:${units[1]}`, label: 'Entry', summary: 'Where it starts', kind: 'entry', evidence: 'main()', details: {} } },
      { op: 'annotation', value: { type: 'summary', id: 's1', parent: `u:${units[2]}`, text: 'A summary' } },
      { op: 'annotation', value: { type: 'tour', id: 't1', steps: [{ target: `u:${units[1]}`, text: 'Start here', highlights: [] }] } },
    ];
    if (victimEdges.length) ops.push({ op: 'remove', kind: 'edge', rows: { ids: victimEdges, cols: {} } });
    ops.push({ op: 'remove', kind: 'file', rows: { ids: [victim], cols: {} } }, { op: 'remove', kind: 'unit', rows: { ids: [victim], cols: {} } });
    store.propose(ops);

    const districts = tables.district.ids, cities = tables.city.ids;
    const layout: LayoutSnapshot = {
      unit: { ids: units.filter((id) => id !== victim), xz: units.slice(1).flatMap((_, k) => [k * 0.5, -1 - k]) },
      district: { ids: districts, xzr: districts.flatMap((_, k) => [k, k, 10]) },
      city: { ids: cities, xzr: cities.flatMap((_, k) => [k * 100, 0, 50]) },
      home: { district: districts.flatMap(() => [0, 0]), city: cities.flatMap(() => [1, 1]) },
    };
    const model = store.toModel(layout);
    expect(model.tables.unit.ids).toHaveLength(units.length - 1);
    expect(model.tables.unit.ids).not.toContain(victim);
    expect(model.layers.recency.values).toHaveLength(units.length - 1);
    expect(model.layers.recency.values[0]).toBeNull();

    const bytes = await encodeModel(model);
    const decoded = await decodeModel(bytes);
    expect(decoded).toEqual(model);
    // interning should pay for itself: the file is smaller than the plain JSON, gzipped
    expect(bytes.length).toBeLessThan((await gzipJson(model)).length);

    const reloaded = createModelStore();
    const seen: boolean[] = [];
    reloaded.subscribe((b) => seen.push(b.full === true));
    reloaded.propose([{ op: 'add', kind: 'city', rows: { ids: ['stale'], cols: { name: ['replaced by load'] } } }]);
    const batch = reloaded.load(decoded);
    expect(batch).toMatchObject({ full: true, rev: 2, baseRev: 1 });
    expect(seen).toEqual([false, true]);
    expect(reloaded.toModel(layout)).toEqual(model);
    expect(reloaded.replica.table('unit').capacity).toBe(units.length - 1);
    expect(reloaded.replica.table('city').has('stale')).toBe(false);

    // an invalid model is refused and the store keeps what it had
    const broken = structuredClone(decoded) as RepoModel;
    broken.tables.edge.cols.dst![0] = 'not/a/unit';
    const before = view(reloaded.replica);
    expect(() => reloaded.load(broken)).toThrow(/not\/a\/unit/);
    expect(view(reloaded.replica)).toEqual(before);
    expect(reloaded.rev).toBe(2);
  });

  it('rejects a file with an unknown schema', async () => {
    await expect(decodeModel(await gzipJson({ format: 'gitmap', schema: 2, strings: [], tables: {} }))).rejects.toThrow(/schema 2/);
    await expect(decodeModel(new TextEncoder().encode('plain text'))).rejects.toThrow(/Not a gitmap file/);
  });
});

describe('diffStructure', () => {
  const a = syntheticTables({ files: 120, seed: 1 });
  const b = syntheticTables({ files: 150, seed: 2 });

  it('from an empty model is plain adds', () => {
    expect(diffStructure(createModelStore().replica, b)).toEqual(tablesToOps(b));
  });

  it('turns structure A into structure B through the store', () => {
    const store = storeWith(a, 'diff');
    const ops = diffStructure(store.replica, b);
    expect(ops.some((op) => op.op === 'update')).toBe(true);
    expect(ops.some((op) => op.op === 'remove')).toBe(true);
    store.propose(ops);
    const result = store.toModel().tables;
    for (const kind of STRUCTURE) {
      expect(rowsById(result[kind as EntityKind]), kind).toEqual(rowsById(b[kind]));
    }
    expect(diffStructure(store.replica, b)).toEqual([]);
  });

  it('reports a unit that only changed district as an assign', () => {
    const store = storeWith(a, 'assign');
    const moved = structuredClone(a);
    const from = moved.unit.cols.district![0];
    const to = moved.district.ids.find((id) => id !== from)!;
    moved.unit.cols.district![0] = to;
    expect(diffStructure(store.replica, moved)).toEqual([{ op: 'assign', unitIds: [moved.unit.ids[0]], districtIds: [to] }]);
  });
});
