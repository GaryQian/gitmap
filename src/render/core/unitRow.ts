// The one place that turns a replica row into what the renderer draws for a unit. Pure.
import type { Config } from '../../config';
import type { ModelReplica } from '../../contracts/store';
import type { PatchBatch } from '../../model/types';
import { glowAmount, unitRadius } from '../../shared';

export interface UnitRow {
  radius: number;
  /** Outward glow, 0..1 (glowAmount). */
  glow: number;
  loc: number;
  lang: string;
  /** District slot, −1 when the unit has no district (it is then not drawn). */
  district: number;
  /** City slot of that district, −1 when unknown. */
  city: number;
}

export type UnitReader = (slot: number) => UnitRow | null;

/** A reader over the replica's current tables. Returns null for an empty slot. */
export function unitReader(replica: ModelReplica, visual: Config['visual']): UnitReader {
  const units = replica.table('unit');
  const districts = replica.table('district');
  return (slot) => {
    if (slot < 0 || slot >= units.capacity || units.ids[slot] == null) return null;
    const district = units.refSlots.district[slot] ?? -1;
    const city = district >= 0 ? (districts.refSlots.city[district] ?? -1) : -1;
    const loc = units.cols.loc[slot];
    const pct = units.cols.importancePct[slot];
    return { radius: unitRadius(loc, pct, visual), glow: glowAmount(pct, visual), loc, lang: units.cols.lang[slot], district, city };
  };
}

/**
 * Which unit slots a batch touches. `all` is set when a district changed (a district's city is baked
 * into each of its units), in which case every live unit is refreshed.
 */
export function touchedUnits(batch: PatchBatch): { slots: number[]; all: boolean } {
  const slots: number[] = [];
  let all = false;
  for (const op of batch.ops) {
    if (op.op === 'assign') {
      if (op.units) for (const s of op.units) slots.push(s);
    } else if (op.op === 'add' || op.op === 'update' || op.op === 'remove') {
      if (op.kind === 'unit') {
        if (op.rows.slots) for (const s of op.rows.slots) slots.push(s);
      } else if (op.kind === 'district') {
        all = true;
      }
    }
  }
  return { slots, all };
}
