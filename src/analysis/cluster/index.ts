// Stage 5 — cities and districts. PLACEHOLDER (package 1E): communities are folders. Package 2A
// replaces this file with Louvain (PLAN.md §6.6) behind the same `cluster` signature.
//
//   city     = a top-level folder; files at the repo root form one city named after the repo
//   district = a second-level folder of its city; folders with fewer than
//              config.clustering.minDistrictSize units, and files directly in the city folder, share
//              one district named after the city
import type { Config } from '../../config';
import type { AnalysisInput } from '../../contracts/pipeline';
import type { UnitEdges } from '../edges';
import { comparePaths } from '../order';
import type { UnitTable } from '../units';
import { matchPrevious, mintIds } from './stableIds';

export interface ClusterResult {
  /** District id per unit, aligned with the UnitTable. */
  unitDistrict: string[];
  /** Every district has at least one unit; ids are unique among districts. */
  districts: { id: string; city: string; name: string }[];
  /** Every city has at least one district; ids are unique among cities. */
  cities: { id: string; name: string }[];
}

export type Cluster = (
  units: UnitTable,
  edges: UnitEdges,
  config: Config,
  previous?: AnalysisInput['previous'],
  /** Names the city of root-level files. */
  repoName?: string,
) => ClusterResult;

/** Id of the city (and district) holding files at the repo root; no folder can be called this. */
const ROOT = '.';

export const cluster: Cluster = (units, _edges, config, previous, repoName = '') => {
  const minSize = config.clustering.minDistrictSize;
  const n = units.count;

  // Group units by top-level folder, then by second-level folder ('' = directly in the city folder).
  const byCity = new Map<string, Map<string, number[]>>();
  for (let u = 0; u < n; u++) {
    const id = units.ids[u];
    const a = id.indexOf('/');
    const b = a < 0 ? -1 : id.indexOf('/', a + 1);
    const cityKey = a < 0 ? ROOT : id.slice(0, a);
    const folder = b < 0 ? '' : id.slice(0, b);
    let folders = byCity.get(cityKey);
    if (!folders) byCity.set(cityKey, (folders = new Map()));
    const members = folders.get(folder);
    if (members) members.push(u); else folders.set(folder, [u]);
  }

  // Fresh communities, in path order.
  const cityIds: string[] = [];
  const cityNames: string[] = [];
  const districtIds: string[] = [];
  const districtNames: string[] = [];
  const districtCity: number[] = [];
  const unitDistrict = new Int32Array(n);
  const unitCity = new Int32Array(n);
  for (const cityKey of [...byCity.keys()].sort(comparePaths)) {
    const folders = byCity.get(cityKey)!;
    const c = cityIds.length;
    const cityName = cityKey === ROOT ? repoName || 'root' : cityKey;
    cityIds.push(cityKey);
    cityNames.push(cityName);
    const shared: number[] = [];
    for (const folder of [...folders.keys()].sort(comparePaths)) {
      const members = folders.get(folder)!;
      if (folder === '' || members.length < minSize) { for (const u of members) shared.push(u); continue; }
      const d = districtIds.length;
      districtIds.push(folder);
      districtNames.push(folder.slice(cityKey.length + 1));
      districtCity.push(c);
      for (const u of members) { unitDistrict[u] = d; unitCity[u] = c; }
    }
    if (shared.length > 0) {
      const d = districtIds.length;
      districtIds.push(cityKey);
      districtNames.push(cityName);
      districtCity.push(c);
      for (const u of shared) { unitDistrict[u] = d; unitCity[u] = c; }
    }
  }

  // Communities that persist keep the ids they had.
  let keptDistrict: (string | undefined)[] = new Array(districtIds.length).fill(undefined);
  let keptCity: (string | undefined)[] = new Array(cityIds.length).fill(undefined);
  if (previous) {
    const prevDistrict = units.ids.map((id) => own(previous.unitDistrict, id));
    const prevCity = prevDistrict.map((d) => (d === undefined ? undefined : own(previous.districtCity, d)));
    keptDistrict = matchPrevious(unitDistrict, districtIds.length, prevDistrict);
    keptCity = matchPrevious(unitCity, cityIds.length, prevCity);
  }
  const finalCity = mintIds(cityIds, keptCity);
  const finalDistrict = mintIds(districtIds, keptDistrict);

  const cities = finalCity.map((id, c) => ({ id, name: cityNames[c] }));
  const districts = finalDistrict.map((id, d) => ({ id, city: finalCity[districtCity[d]], name: districtNames[d] }));
  cities.sort((x, y) => comparePaths(x.id, y.id));
  districts.sort((x, y) => comparePaths(x.id, y.id));
  return { unitDistrict: Array.from(unitDistrict, (d) => finalDistrict[d]), districts, cities };
};

function own(record: Record<string, string>, key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}
