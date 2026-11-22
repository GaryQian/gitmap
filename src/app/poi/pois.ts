// Reading points of interest out of the replica for the chrome. Pure, no React.
import type { Config } from '../../config';
import type { ModelReplica } from '../../contracts/store';
import type { Poi, UnitRef } from '../../model/types';
import { unitRadius } from '../../shared';
import { unitSlotOf } from '../units';

/** The file a point of interest stands on (PLAN.md §11.3: always a file's sphere). */
export interface PoiParent {
  /** The unit's id: its primary file's path. */
  path: string;
  /** World radius of the star, before any selection scaling. */
  radius: number;
}

/** The parent star of a point of interest, or null when that file is gone. */
export function poiParent(replica: ModelReplica, ref: UnitRef, visual: Config['visual']): PoiParent | null {
  const slot = unitSlotOf(replica, ref);
  const units = replica.table('unit');
  const path = slot < 0 ? null : units.ids[slot];
  if (path == null) return null;
  return { path, radius: unitRadius(units.cols.loc[slot] ?? 0, units.cols.importancePct[slot] ?? 0, visual) };
}

export interface LivePoi { poi: Poi; parent: PoiParent }

/** The points of interest whose parent still exists, in annotation order. */
export function livePois(replica: ModelReplica, visual: Config['visual']): LivePoi[] {
  const out: LivePoi[] = [];
  for (const a of replica.annotations) {
    if (a.type !== 'poi') continue;
    const parent = poiParent(replica, a.parent, visual);
    if (parent) out.push({ poi: a, parent });
  }
  return out;
}
