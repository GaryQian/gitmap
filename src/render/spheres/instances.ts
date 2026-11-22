// The model-derived half of the sphere instance buffers, and the functions that write it. Pure: no
// three.js, no WebGL. `projectUnits` is the only writer (PLAN.md §5.1 rule 4); it reads the replica,
// which has already applied the batch, so add / update / remove / assign all reduce to "refresh
// these slots from the replica".
import type { Config } from '../../config';
import type { ModelReplica } from '../../contracts/store';
import type { NodeRef, PatchBatch } from '../../model/types';
import { cityRef } from '../../model/types';
import { glowAmount, hexToRgb, languageColor } from '../../shared';
import { touchedUnits, unitReader, type UnitRow } from '../core/unitRow';

/** Items per instance in each buffer. */
export const SLOT_ITEMS = 3;   // unit slot, district slot, city slot
export const SHAPE_ITEMS = 4;  // radius, glow, lines of code, alive
export const COLOR_ITEMS = 4;  // r, g, b (0..255), language index

export interface InstanceBuffers {
  /** Instances the arrays can hold. Instance i is unit slot i. */
  capacity: number;
  slot: Float32Array;
  shape: Float32Array;
  color: Uint8Array;
}

/** Languages seen so far → a small stable index, for the type-filter lookup. Index 255 is shared overflow. */
export class LangTable {
  static readonly OVERFLOW = 255;
  readonly langs: string[] = [];
  private byLang = new Map<string, { index: number; rgb: [number, number, number] }>();
  constructor(private visual: Config['visual']) {}

  entry(lang: string): { index: number; rgb: [number, number, number] } {
    let e = this.byLang.get(lang);
    if (!e) {
      const [r, g, b] = hexToRgb(languageColor(lang, this.visual));
      const index = this.langs.length < LangTable.OVERFLOW ? this.langs.push(lang) - 1 : LangTable.OVERFLOW;
      this.byLang.set(lang, (e = { index, rgb: [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)] }));
    }
    return e;
  }
}

export function createInstanceBuffers(capacity: number): InstanceBuffers {
  return {
    capacity,
    slot: new Float32Array(capacity * SLOT_ITEMS),
    shape: new Float32Array(capacity * SHAPE_ITEMS),
    color: new Uint8Array(capacity * COLOR_ITEMS),
  };
}

/** A larger copy. Capacity at least doubles so growth is rare. */
export function growInstanceBuffers(b: InstanceBuffers, needed: number): InstanceBuffers {
  const out = createInstanceBuffers(Math.max(needed, b.capacity * 2));
  out.slot.set(b.slot); out.shape.set(b.shape); out.color.set(b.color);
  return out;
}

/** Write one instance from its row, or clear it when the slot is empty. */
export function writeInstance(b: InstanceBuffers, slot: number, row: UnitRow | null, langs: LangTable): void {
  const s = slot * SLOT_ITEMS, h = slot * SHAPE_ITEMS, c = slot * COLOR_ITEMS;
  if (!row) {
    b.slot.fill(0, s, s + SLOT_ITEMS); b.shape.fill(0, h, h + SHAPE_ITEMS); b.color.fill(0, c, c + COLOR_ITEMS);
    return;
  }
  const lang = langs.entry(row.lang);
  b.slot[s] = slot; b.slot[s + 1] = row.district; b.slot[s + 2] = row.city;
  b.shape[h] = row.radius; b.shape[h + 1] = row.glow; b.shape[h + 2] = row.bytes; b.shape[h + 3] = 1;
  b.color[c] = lang.rgb[0]; b.color[c + 1] = lang.rgb[1]; b.color[c + 2] = lang.rgb[2]; b.color[c + 3] = lang.index;
}

export interface Projection {
  /** The buffers to use from now on (a new object when they had to grow). */
  buffers: InstanceBuffers;
  /** Slots that were rewritten; null when every slot was. */
  touched: number[] | null;
}

/**
 * Project a batch (already applied to `replica`) into the instance buffers. With `rebuild`, or when
 * the batch changes a district, every slot is rewritten from the replica.
 */
export function projectUnits(buffers: InstanceBuffers, batch: PatchBatch, rebuild: boolean, replica: ModelReplica, visual: Config['visual'], langs: LangTable): Projection {
  const capacity = replica.table('unit').capacity;
  const b = buffers.capacity >= capacity ? buffers : growInstanceBuffers(buffers, capacity);
  const read = unitReader(replica, visual);
  const touched = rebuild ? null : touchedUnits(batch);
  if (!touched || touched.all) {
    b.slot.fill(0); b.shape.fill(0); b.color.fill(0);
    for (let s = 0; s < capacity; s++) writeInstance(b, s, read(s), langs);
    return { buffers: b, touched: null };
  }
  const slots = touched.slots.filter((s) => s >= 0 && s < b.capacity);
  for (const s of slots) writeInstance(b, s, read(s), langs);
  return { buffers: b, touched: slots };
}

/** The size slider's rule (PLAN.md §8.1): small files are hidden, glowing files never are. */
export function hiddenByMinBytes(bytes: number, glow: number, minBytes: number): boolean {
  return bytes < minBytes && glow <= 0;
}

/** Units not hidden by the size slider, per city, for the pills. */
export function visibleCounts(replica: ModelReplica, minBytes: number, visual: Config['visual']): Map<NodeRef, { visible: number; total: number }> {
  const units = replica.table('unit'), districts = replica.table('district'), cities = replica.table('city');
  const out = new Map<NodeRef, { visible: number; total: number }>();
  const perCity: ({ visible: number; total: number } | undefined)[] = [];
  for (let c = 0; c < cities.capacity; c++) {
    const id = cities.ids[c];
    if (id == null) continue;
    out.set(cityRef(id), (perCity[c] = { visible: 0, total: 0 }));
  }
  for (let u = 0; u < units.capacity; u++) {
    if (units.ids[u] == null) continue;
    const d = units.refSlots.district[u] ?? -1;
    const entry = d >= 0 ? perCity[districts.refSlots.city[d] ?? -1] : undefined;
    if (!entry) continue;
    entry.total++;
    if (!hiddenByMinBytes(units.cols.bytes[u], glowAmount(units.cols.importancePct[u], visual), minBytes)) entry.visible++;
  }
  return out;
}
