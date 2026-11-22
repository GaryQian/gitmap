// City names for the chrome: the title AI notes gave a city when there is one, else the name derived
// from its folders (src/shared/cityTitles.ts has the rule). Read from the replica, and worked out
// once per model revision: the pills, the cards and the chat all ask.
import type { ModelReplica } from '../contracts/store';
import { cityTitles, type CityName } from '../shared/cityTitles';

export type { CityName };

const cache = new WeakMap<ModelReplica, { rev: number; annotations: unknown; names: Map<string, CityName> }>();

/** Every city's name, by city id. */
export function cityNames(replica: ModelReplica): Map<string, CityName> {
  const hit = cache.get(replica);
  if (hit && hit.rev === replica.rev && hit.annotations === replica.annotations) return hit.names;
  const table = replica.table('city');
  const cities = table.slots().map((slot) => ({ id: table.ids[slot]!, name: table.cols.name[slot] ?? '' }));
  const labels = new Map<string, string | undefined>();
  // the last summary written for a city wins, as it does on the summary card
  for (const a of replica.annotations) {
    if (a.type === 'summary' && a.parent.startsWith('c:') && a.text.trim() !== '') labels.set(a.parent.slice(2), a.label);
  }
  const names = cityTitles(cities, labels);
  cache.set(replica, { rev: replica.rev, annotations: replica.annotations, names });
  return names;
}

/** The name a city goes by on screen; '' for a city that is gone. */
export function cityTitle(replica: ModelReplica, cityId: string | null | undefined): string {
  return cityId == null ? '' : (cityNames(replica).get(cityId)?.title ?? '');
}
