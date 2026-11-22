// What a city or a district is called, for the chrome that names one (the selection pills, the chat).
import type { ModelReplica } from '../contracts/store';
import type { NodeRef } from '../model/types';
import { cityNames } from './cityNames';

export interface AreaName {
  kind: 'city' | 'district';
  /** A city goes by the title AI notes gave it, once it has one. */
  name: string;
  /** A district's city, when it is known. */
  city?: string;
}

/** The name of a city ("c:…") or district ("d:…") ref; null for anything else, or one that is gone. */
export function areaName(replica: ModelReplica, ref: NodeRef): AreaName | null {
  const id = ref.slice(2);
  if (ref.startsWith('c:')) {
    if (replica.table('city').slotOf(id) < 0) return null;
    return { kind: 'city', name: cityNames(replica).get(id)?.title || 'City' };
  }
  if (!ref.startsWith('d:')) return null;
  const districts = replica.table('district');
  const slot = districts.slotOf(id);
  if (slot < 0) return null;
  const citySlot = districts.refSlots.city?.[slot] ?? -1;
  const cityId = citySlot >= 0 ? replica.table('city').ids[citySlot] : null;
  const city = cityId == null ? undefined : cityNames(replica).get(cityId)?.title || undefined;
  return { kind: 'district', name: districts.cols.name[slot] || 'District', ...(city ? { city } : {}) };
}
