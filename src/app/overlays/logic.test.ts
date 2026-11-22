import { describe, expect, it } from 'vitest';
import { createModelStore, edgeId, type StructureTables } from '../../model';
import type { HistoryContributor } from '../../overlays';
import { tablesToOps } from '../../testing/synthetic';
import { announcedPercent, batchTouches, filterContributors, historyUnavailable, pillState, seedSlots, touchesOverlay } from './logic';

const people: HistoryContributor[] = [
  { id: 1, name: 'Grace Hopper', commits: 40 },
  { id: 2, name: 'Ada Lovelace', commits: 120 },
  { id: 3, name: 'José Álvarez', commits: 40 },
  { id: 4, name: 'Alan Turing', commits: 7 },
  { id: 5, name: 'Barbara Liskov', commits: 40 },
];
const names = (list: HistoryContributor[]) => list.map((c) => c.name);

describe('contributor picker', () => {
  it('lists everyone for an empty query, most commits first, ties by name', () => {
    expect(names(filterContributors(people, '  '))).toEqual(['Ada Lovelace', 'Barbara Liskov', 'Grace Hopper', 'José Álvarez', 'Alan Turing']);
    expect(people[0].name).toBe('Grace Hopper'); // the input is left as it was
  });

  it('matches part of a name, in any case and word order, and keeps the commit order', () => {
    expect(names(filterContributors(people, 'LOV'))).toEqual(['Ada Lovelace']);
    expect(names(filterContributors(people, 'turing al'))).toEqual(['Alan Turing']);
    // two matches: the order is still by commits, then name
    expect(names(filterContributors(people, 'al'))).toEqual(['José Álvarez', 'Alan Turing']);
    expect(filterContributors(people, 'zzz')).toEqual([]);
  });

  it('forgives a typo and an accent', () => {
    expect(names(filterContributors(people, 'lovelcae'))).toEqual(['Ada Lovelace']);
    expect(names(filterContributors(people, 'jose alvarez'))).toEqual(['José Álvarez']);
  });

  it('puts names that match as typed before names that match with a typo', () => {
    const list = [{ id: 1, name: 'Hopper', commits: 1 }, { id: 2, name: 'Hoppen', commits: 99 }];
    expect(names(filterContributors(list, 'hopper'))).toEqual(['Hopper', 'Hoppen']);
  });
});

describe('pill state', () => {
  const history = { layer: 'recency', needs: { history: true, graph: false, selection: false, contributor: false } };
  const tests = { layer: 'tests', needs: { history: false, graph: true, selection: false, contributor: false } };
  const reach = { layer: null, needs: { history: false, graph: true, selection: true, contributor: false } };

  it('follows the layer: no data, arriving with its coverage, finished', () => {
    expect(pillState(history, undefined, false)).toEqual({ kind: 'pending' });
    expect(pillState(history, { status: 'pending', coverage: 0 }, false)).toEqual({ kind: 'pending' });
    expect(pillState(history, { status: 'partial', coverage: 0.64 }, false)).toEqual({ kind: 'partial', coverage: 0.64 });
    expect(pillState(history, { status: 'partial', coverage: NaN }, false)).toEqual({ kind: 'partial', coverage: 0 });
    expect(pillState(history, { status: 'partial', coverage: 3 }, false)).toEqual({ kind: 'partial', coverage: 1 });
    expect(pillState(history, { status: 'complete', coverage: 1 }, false)).toEqual({ kind: 'complete' });
  });

  it('announces progress in quarters, not on every batch', () => {
    expect([0, 0.1, 0.249, 0.25, 0.6, 0.99, 1, NaN].map(announcedPercent)).toEqual([0, 0, 0, 25, 50, 75, 75, 0]);
  });

  it('hides a history overlay that can never have data, and only that', () => {
    expect(pillState(history, undefined, true)).toEqual({ kind: 'hidden' });
    // a demo ships its history layers finished: they show although there is no history to read
    expect(pillState(history, { status: 'complete', coverage: 1 }, true)).toEqual({ kind: 'complete' });
    expect(pillState(tests, undefined, true)).toEqual({ kind: 'pending' });
    expect(pillState(reach, undefined, true)).toEqual({ kind: 'complete' });
  });

  it('knows when history will never come', () => {
    expect(historyUnavailable(false, 'git', true)).toBe(false);
    expect(historyUnavailable(true, 'git', true)).toBe(true);
    expect(historyUnavailable(false, 'folder', true)).toBe(true);
    expect(historyUnavailable(false, 'demo', false)).toBe(true);
    expect(historyUnavailable(false, 'import', true)).toBe(false);
    expect(historyUnavailable(false, undefined, false)).toBe(false);
  });
});

describe('reach seeds', () => {
  // two cities; d1 and d2 in c1, d3 in c2; h + i form one unit (header and implementation)
  const unitIds = ['a', 'b', 'c', 'd', 'e', 'h'];
  const tables: StructureTables = {
    city: { ids: ['c1', 'c2'], cols: { name: ['c1', 'c2'] } },
    district: { ids: ['d1', 'd2', 'd3'], cols: { city: ['c1', 'c1', 'c2'], name: ['d1', 'd2', 'd3'] } },
    unit: { ids: unitIds, cols: { primaryFile: unitIds, district: ['d1', 'd1', 'd2', 'd3', 'd3', 'd3'] } },
    file: { ids: [...unitIds, 'i'], cols: { unit: [...unitIds, 'h'] } },
    edge: { ids: [edgeId('a', 'b')], cols: { src: ['a'], dst: ['b'] } },
  };
  const store = createModelStore();
  store.propose(tablesToOps(tables));
  const replica = store.replica;
  const units = replica.table('unit');
  const ids = (slots: number[]) => slots.map((s) => units.ids[s]).sort();

  it('takes files as themselves and districts and cities as every file in them', () => {
    expect(ids(seedSlots(['u:d'], replica))).toEqual(['d']);
    expect(ids(seedSlots(['d:d1'], replica))).toEqual(['a', 'b']);
    expect(ids(seedSlots(['c:c1'], replica))).toEqual(['a', 'b', 'c']);
    expect(ids(seedSlots(['f:i'], replica))).toEqual(['h']);
  });

  it('merges a mixed selection without repeats and skips what is gone', () => {
    const slots = seedSlots(['u:a', 'd:d1', 'u:e', 'c:c1', 'u:gone', 'd:gone'], replica);
    expect(ids(slots)).toEqual(['a', 'b', 'c', 'e']);
    expect(slots).toEqual([...slots].sort((x, y) => x - y));
    expect(seedSlots([], replica)).toEqual([]);
  });
});

describe('what a batch changed', () => {
  const recency = { layer: 'recency' }, reach = { layer: null };
  it('rebuilds an overlay for its own layer or a change of structure, not for another layer', () => {
    const layer = batchTouches({ rev: 2, baseRev: 1, ops: [{ op: 'layer', id: 'ownership', unitIds: [], values: [] }, { op: 'progress', subsystem: 'history', done: 1, total: 2 }] });
    expect(touchesOverlay(layer, recency)).toBe(false);
    expect(touchesOverlay(layer, { layer: 'ownership' })).toBe(true);
    expect(touchesOverlay(layer, reach)).toBe(false);
    const edges = batchTouches({ rev: 3, baseRev: 2, ops: [{ op: 'remove', kind: 'edge', rows: { ids: ['x'], cols: {} } }] });
    expect(touchesOverlay(edges, reach)).toBe(true);
    expect(touchesOverlay(edges, recency)).toBe(true);
    expect(touchesOverlay(batchTouches({ rev: 4, baseRev: 0, ops: [], full: true }), recency)).toBe(true);
  });
});
