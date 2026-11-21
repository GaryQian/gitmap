import { describe, expect, it } from 'vitest';
import { config } from '../../config';
import { createReplica } from '../../model';
import type { PatchBatch } from '../../model/types';
import { glowAmount, hexToRgb, languageColor, unitRadius } from '../../shared';
import { syntheticBatch } from '../../testing/synthetic';
import {
  COLOR_ITEMS, LangTable, SHAPE_ITEMS, SLOT_ITEMS, createInstanceBuffers, hiddenByMinLines, projectUnits, visibleCounts,
} from './instances';

const visual = config.visual;

function setup(files = 120) {
  const replica = createReplica();
  const batch = syntheticBatch({ files, seed: 7 });
  replica.apply(batch);
  const langs = new LangTable(visual);
  const first = projectUnits(createInstanceBuffers(8), batch, true, replica, visual, langs);
  return { replica, batch, langs, buffers: first.buffers };
}

/** What a rebuild from the replica produces, with the same language indices. */
function rebuilt(replica: ReturnType<typeof createReplica>, langs: LangTable, capacity: number) {
  return projectUnits(createInstanceBuffers(capacity), { rev: replica.rev, baseRev: replica.rev, ops: [], full: true }, true, replica, visual, langs).buffers;
}

describe('sphere instance projection', () => {
  it('writes one instance per unit slot from a full batch', () => {
    const { replica, buffers } = setup();
    const units = replica.table('unit'), districts = replica.table('district');
    expect(buffers.capacity).toBeGreaterThanOrEqual(units.capacity);
    for (const s of units.slots()) {
      const d = units.refSlots.district[s];
      expect(Array.from(buffers.slot.subarray(s * SLOT_ITEMS, s * SLOT_ITEMS + 3))).toEqual([s, d, districts.refSlots.city[d]]);
      expect(buffers.shape[s * SHAPE_ITEMS]).toBeCloseTo(unitRadius(units.cols.loc[s], units.cols.importancePct[s], visual), 4);
      expect(buffers.shape[s * SHAPE_ITEMS + 1]).toBeCloseTo(glowAmount(units.cols.importancePct[s], visual), 5);
      expect(buffers.shape[s * SHAPE_ITEMS + 2]).toBe(units.cols.loc[s]);
      expect(buffers.shape[s * SHAPE_ITEMS + 3]).toBe(1);
      const rgb = hexToRgb(languageColor(units.cols.lang[s], visual)).map((v) => Math.round(v * 255));
      expect(Array.from(buffers.color.subarray(s * COLOR_ITEMS, s * COLOR_ITEMS + 3))).toEqual(rgb);
    }
  });

  it('applying add, update, remove and assign one batch at a time equals a rebuild', () => {
    const { replica, langs, buffers: initial } = setup();
    let buffers = initial;
    const units = replica.table('unit'), districts = replica.table('district');
    const cap = units.capacity;
    const districtA = units.cols.district[0];
    const districtB = districts.ids[districts.slots().find((d) => districts.ids[d] !== districtA)!]!;
    const batches: PatchBatch[] = [
      { rev: 2, baseRev: 1, ops: [{ op: 'add', kind: 'unit', rows: { ids: ['new/a.rs', 'new/b.kt'], slots: [cap, cap + 1], cols: { primaryFile: ['new/a.rs', 'new/b.kt'], loc: [4000, 12], lang: ['rust', 'kotlin'], importancePct: [1, 0], district: [districtA, districtB] } } }] },
      { rev: 3, baseRev: 2, ops: [{ op: 'update', kind: 'unit', rows: { ids: [units.ids[3]!], slots: [3], cols: { loc: [9000], importancePct: [0.99], lang: ['go'] } } }] },
      { rev: 4, baseRev: 3, ops: [{ op: 'remove', kind: 'unit', rows: { ids: [units.ids[5]!, units.ids[6]!], slots: [5, 6], cols: {} } }] },
      { rev: 5, baseRev: 4, ops: [{ op: 'assign', unitIds: [units.ids[9]!], districtIds: [districtB], units: [9], districts: [districts.slotOf(districtB)] }] },
      // a slot freed by the remove is reused
      { rev: 6, baseRev: 5, ops: [{ op: 'add', kind: 'unit', rows: { ids: ['new/c.py'], slots: [5], cols: { primaryFile: ['new/c.py'], loc: [300], lang: ['python'], importancePct: [0.5], district: [districtA] } } }] },
    ];
    for (const batch of batches) {
      expect(replica.apply(batch)).toBe(true);
      const result = projectUnits(buffers, batch, false, replica, visual, langs);
      buffers = result.buffers;
      expect(result.touched).not.toBeNull();
      const expected = rebuilt(replica, langs, buffers.capacity);
      expect(Array.from(buffers.slot)).toEqual(Array.from(expected.slot));
      expect(Array.from(buffers.shape)).toEqual(Array.from(expected.shape));
      expect(Array.from(buffers.color)).toEqual(Array.from(expected.color));
    }
    // the removed slot that was not reused is cleared; the added ones are alive
    expect(buffers.shape[6 * SHAPE_ITEMS + 3]).toBe(0);
    expect(buffers.shape[cap * SHAPE_ITEMS + 3]).toBe(1);
    expect(buffers.shape[cap * SHAPE_ITEMS]).toBeCloseTo(unitRadius(4000, 1, visual), 4);
  });

  it('refreshes every unit when a district moves to another city', () => {
    const { replica, langs } = setup();
    let buffers = rebuilt(replica, langs, 8);
    const districts = replica.table('district'), cities = replica.table('city');
    const d = districts.slots()[0];
    const other = cities.ids[cities.slots().find((c) => c !== districts.refSlots.city[d])!]!;
    const batch: PatchBatch = { rev: 2, baseRev: 1, ops: [{ op: 'update', kind: 'district', rows: { ids: [districts.ids[d]!], slots: [d], cols: { city: [other] } } }] };
    replica.apply(batch);
    const result = projectUnits(buffers, batch, false, replica, visual, langs);
    buffers = result.buffers;
    expect(result.touched).toBeNull();
    const units = replica.table('unit');
    const moved = units.slots().filter((s) => units.refSlots.district[s] === d);
    expect(moved.length).toBeGreaterThan(0);
    for (const s of moved) expect(buffers.slot[s * SLOT_ITEMS + 2]).toBe(cities.slotOf(other));
  });

  it('gives languages stable indices and one shared overflow index', () => {
    const langs = new LangTable(visual);
    const a = langs.entry('ts').index;
    expect(langs.entry('python').index).not.toBe(a);
    expect(langs.entry('ts').index).toBe(a);
    for (let i = 0; i < 400; i++) langs.entry(`lang-${i}`);
    expect(langs.entry('lang-399').index).toBe(LangTable.OVERFLOW);
    expect(langs.langs.length).toBeLessThanOrEqual(LangTable.OVERFLOW);
  });
});

describe('size slider visibility', () => {
  it('hides small files but never glowing ones', () => {
    expect(hiddenByMinLines(10, 0, 50)).toBe(true);
    expect(hiddenByMinLines(10, 0.2, 50)).toBe(false);
    expect(hiddenByMinLines(80, 0, 50)).toBe(false);
    expect(hiddenByMinLines(10, 0, 0)).toBe(false);
  });

  it('counts visible and total units per city', () => {
    const { replica } = setup(300);
    const units = replica.table('unit');
    const all = visibleCounts(replica, 0, visual);
    expect(all.size).toBe(replica.table('city').count);
    let total = 0;
    for (const c of all.values()) { expect(c.visible).toBe(c.total); total += c.total; }
    expect(total).toBe(units.count);
    // with the slider at its far end only the glowing files remain
    const glowing = units.slots().filter((s) => glowAmount(units.cols.importancePct[s], visual) > 0).length;
    let visible = 0;
    for (const c of visibleCounts(replica, Number.MAX_SAFE_INTEGER, visual).values()) visible += c.visible;
    expect(visible).toBe(glowing);
  });
});
