import { describe, expect, it } from 'vitest';
import { config, withConfig } from '../../config';
import { createModelStore, edgeId, type StructureTables } from '../../model';
import { RECENCY_OLDER, TESTS, ownershipShare, type FileHistory, type HistoryInput } from '../../overlays';
import { tablesToOps } from '../../testing/synthetic';
import { historyLayers, testsLayer, testsValues, type LayerPatch } from './index';

/** A small hand-written structure: one district, units given as [id, lang, extra files], edges as [src, dst]. */
function structure(units: [id: string, lang: string, more?: string[]][], edges: [string, string][] = []): StructureTables {
  const files = units.flatMap(([id, lang, more = []]) => [id, ...more].map((path) => ({ path, lang, unit: id })));
  return {
    city: { ids: ['c'], cols: { name: ['c'] } },
    district: { ids: ['d'], cols: { city: ['c'], name: ['d'] } },
    unit: { ids: units.map((u) => u[0]), cols: { primaryFile: units.map((u) => u[0]), lang: units.map((u) => u[1]), fileCount: units.map((u) => 1 + (u[2]?.length ?? 0)), district: units.map(() => 'd') } },
    file: { ids: files.map((f) => f.path), cols: { lang: files.map((f) => f.lang), unit: files.map((f) => f.unit) } },
    edge: { ids: edges.map(([s, d]) => edgeId(s, d)), cols: { src: edges.map((e) => e[0]), dst: edges.map((e) => e[1]) } },
  };
}

const DAY = 86400, NOW = 1_800_000_000;
const hist = (daysAgo: number, authors: [number, number][], firstDaysAgo = 900): FileHistory => ({
  lastModified: NOW - daysAgo * DAY, firstSeen: NOW - firstDaysAgo * DAY, commits: authors.reduce((n, a) => n + a[1], 0), authors,
});
const input = (files: Record<string, FileHistory>, over: Partial<HistoryInput> = {}): HistoryInput => ({
  contributors: [{ id: 1, name: 'Ada', commits: 40 }, { id: 2, name: 'Bo', commits: 9 }, { id: 3, name: 'Cy', commits: 12 }],
  files, coverage: 0.5, complete: false, recencyComplete: false, now: NOW, ...over,
});
const valuesOf = (op: LayerPatch) => Object.fromEntries(op.unitIds.map((id, i) => [id, op.values[i]]));
const layer = (ops: LayerPatch[], id: string) => ops.find((op) => op.id === id)!;

describe('history layers', () => {
  const tables = structure([['a.ts', 'ts'], ['b.ts', 'ts'], ['w.cc', 'cpp', ['w.h']], ['new.ts', 'ts']]);
  const facts = {
    'a.ts': hist(2, [[1, 9], [2, 1]]),
    'b.ts': hist(400, [[2, 1], [3, 1]]),
    'w.cc': hist(30, [[1, 2], [3, 1]], 500),
    'w.h': hist(10, [[3, 4]], 800),
  };

  it('recency holds raw last-modified seconds; a two-file unit takes the newest', () => {
    const { ops } = historyLayers(input(facts), tables);
    const recency = layer(ops, 'recency');
    const v = valuesOf(recency);
    expect(v['a.ts']).toBe(NOW - 2 * DAY);
    expect(v['w.cc']).toBe(NOW - 10 * DAY);
    expect(v['new.ts']).toBeNaN();
    expect(recency.status).toBe('partial');
    expect(recency.coverage).toBeCloseTo(3 / 4);
    expect(recency.def?.id).toBe('recency');
  });

  it('recency completes early, and units never seen become "older than the window"', () => {
    const { ops } = historyLayers(input(facts, { recencyComplete: true }), tables);
    expect(layer(ops, 'recency').status).toBe('complete');
    expect(valuesOf(layer(ops, 'recency'))['new.ts']).toBe(RECENCY_OLDER);
    expect(RECENCY_OLDER).toBeLessThan(NOW - 400 * DAY);
    // the other two still need the whole window
    expect(layer(ops, 'ownership').status).toBe('partial');
    expect(layer(ops, 'knowledgeRisk').status).toBe('partial');
    expect(historyLayers(input(facts, { complete: true, coverage: 1 }), tables).ops.every((op) => op.status === 'complete')).toBe(true);
  });

  it('knowledge risk is the top author share, and needs the configured minimum of commits', () => {
    const min = config.overlays.knowledgeRisk.minCommits;
    const few = hist(1, [[1, min - 1]]), enough = hist(1, [[1, min]]);
    const t = structure([['few.ts', 'ts'], ['enough.ts', 'ts'], ['a.ts', 'ts'], ['w.cc', 'cpp', ['w.h']]]);
    const v = valuesOf(layer(historyLayers(input({ ...facts, 'few.ts': few, 'enough.ts': enough }), t).ops, 'knowledgeRisk'));
    expect(v['few.ts']).toBeNaN();
    expect(v['enough.ts']).toBe(1);
    expect(v['a.ts']).toBeCloseTo(0.9);
    // w.cc + w.h: author counts add → Cy 5 of 7
    expect(v['w.cc']).toBeCloseTo(5 / 7);
    const strict = withConfig({ overlays: { knowledgeRisk: { minCommits: 8 } } });
    expect(valuesOf(layer(historyLayers(input(facts), t, strict).ops, 'knowledgeRisk'))['w.cc']).toBeNaN();
  });

  it('ownership carries commit totals and per-unit author counts; shares come out on the replica', () => {
    const { ops } = historyLayers(input(facts), tables);
    const ownership = layer(ops, 'ownership');
    const v = valuesOf(ownership);
    expect(v['a.ts']).toBe(10);
    expect(v['w.cc']).toBe(7);
    expect(v['new.ts']).toBeNaN();

    const store = createModelStore();
    store.propose(tablesToOps(tables));
    store.propose(ops);
    const replica = store.replica, units = replica.table('unit');
    const got = replica.layers.get('ownership')!;
    const share = (who: number, id: string) => ownershipShare(got, who, replica)[units.slotOf(id)];
    expect(share(1, 'a.ts')).toBeCloseTo(0.9);
    expect(share(2, 'a.ts')).toBeCloseTo(0.1);
    expect(share(3, 'a.ts')).toBe(0);
    expect(share(3, 'w.cc')).toBeCloseTo(5 / 7);
    expect(share(1, 'new.ts')).toBeNaN();
    // contributors arrive sorted for the picker
    expect((got.extra!.contributors as { name: string }[]).map((c) => c.name)).toEqual(['Ada', 'Cy', 'Bo']);
  });

  it('a later call with the previous state proposes only what changed, and the model ends up the same', () => {
    const first = historyLayers(input({ 'a.ts': facts['a.ts'] }, { coverage: 0.2 }), tables);
    const second = historyLayers(input(facts, { coverage: 0.5 }), tables, config, first.state);
    expect(layer(second.ops, 'recency').unitIds.sort()).toEqual(['b.ts', 'w.cc']);
    expect(layer(second.ops, 'ownership').unitIds.sort()).toEqual(['b.ts', 'w.cc']);

    const stepwise = createModelStore(), atOnce = createModelStore();
    for (const s of [stepwise, atOnce]) s.propose(tablesToOps(tables));
    stepwise.propose(first.ops);
    stepwise.propose(second.ops);
    atOnce.propose(historyLayers(input(facts, { coverage: 0.5 }), tables).ops);
    for (const id of ['recency', 'ownership', 'knowledgeRisk']) {
      const a = stepwise.replica.layers.get(id)!, b = atOnce.replica.layers.get(id)!;
      expect(Array.from(a.values)).toEqual(Array.from(b.values));
      expect(a.extra).toEqual(b.extra);
      expect(a.status).toBe(b.status);
    }
  });

  it('reads structure from a replica as well as from tables', () => {
    const store = createModelStore();
    store.propose(tablesToOps(tables));
    const fromReplica = historyLayers(input(facts), store.replica).ops.map(valuesOf);
    expect(fromReplica).toEqual(historyLayers(input(facts), tables).ops.map(valuesOf));
  });
});

describe('tests layer', () => {
  it('classifies paths against the configured patterns', () => {
    const cases: [string, boolean][] = [
      ['tests/unit/a.py', true], ['pkg/test/helpers.go', true], ['src/__tests__/x.tsx', true], ['pkg/util_test.go', true],
      ['src/app.test.ts', true], ['src/app.spec.js', true], ['java/com/x/FooTest.java', true], ['py/test_thing.py', true],
      ['src/app.ts', false], ['src/contest/latest.ts', false], ['src/testing.ts', false], ['docs/attest.md', false],
    ];
    const t = structure(cases.map(([path]) => [path, 'ts']));
    const { unitIds, values } = testsValues(t, config.overlays.tests.patterns);
    for (const [path, isTest] of cases) expect([path, values[unitIds.indexOf(path)] === TESTS.test]).toEqual([path, isTest]);
  });

  it('marks source a test references, source no test references, and leaves non-code alone', () => {
    const t = structure(
      [['src/a.ts', 'ts'], ['src/b.ts', 'ts'], ['src/c.ts', 'ts'], ['src/a.test.ts', 'ts'], ['tests/util.ts', 'ts'], ['README.md', 'other'], ['tests/data.json', 'other']],
      [['src/a.test.ts', 'src/a.ts'], ['src/a.ts', 'src/b.ts'], ['src/c.ts', 'src/a.test.ts'], ['src/a.test.ts', 'tests/util.ts'], ['src/a.test.ts', 'README.md']],
    );
    const op = testsLayer(t);
    const v = valuesOf(op);
    expect(v['src/a.test.ts']).toBe(TESTS.test);
    expect(v['tests/util.ts']).toBe(TESTS.test);
    expect(v['src/a.ts']).toBe(TESTS.covered);
    // b is only reached through a, and c only points at a test: neither is referenced by one
    expect(v['src/b.ts']).toBe(TESTS.uncovered);
    expect(v['src/c.ts']).toBe(TESTS.uncovered);
    expect(v['README.md']).toBeNaN();
    expect(v['tests/data.json']).toBeNaN();
    expect(op.status).toBe('complete');
    // the same answer from a replica, and the store accepts the patch
    const store = createModelStore();
    store.propose(tablesToOps(t));
    expect(valuesOf(testsLayer(store.replica))).toEqual(v);
    store.propose([op]);
    expect(store.replica.layers.get('tests')!.def.kind).toBe('categorical');
  });
});
