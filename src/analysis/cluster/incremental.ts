// Incremental clustering for "N files changed · Update" (PLAN.md §6.8): nothing is re-clustered.
//
// Re-running Louvain after a small change is not local: dropping 1% of tensorflow's files and
// clustering again moved a third of the remaining files to a different district. An Update must move
// only what changed, so here every unit that had a district keeps it, and only the new units are
// placed:
//   1. in the district they are most connected to (edge weight × confidence, both directions);
//   2. failing that, in the district that holds most of the files of their own directory, then of
//      each parent directory up to the root.
// Districts that lost every unit disappear; cities, ids and names are the previous ones. Balance is
// not maintained here: a district can grow with each Update until the next full clustering ("Apply",
// or opening the repo afresh) redraws the map.
//
// It applies when the caller asks for it (`previous.incremental`) and most of the map is known; with
// too many new units the previous structure says too little, and null sends the caller back to a
// full clustering.
import type { Config } from '../../config';
import type { AnalysisInput } from '../../contracts/pipeline';
import type { UnitEdges } from '../edges';
import { comparePaths } from '../order';
import type { UnitTable } from '../units';

interface Result {
  unitDistrict: string[];
  districts: { id: string; city: string; name: string }[];
  cities: { id: string; name: string }[];
}

/** Share of units that may be new before an incremental pass is refused. */
const DEFAULT_MAX_NEW = 0.2;

/** True when the caller asked for an Update-style pass. Read structurally: the flag is optional in the contract. */
export function wantsIncremental(previous: AnalysisInput['previous']): boolean {
  return !!previous && (previous as { incremental?: boolean }).incremental === true;
}

export function clusterIncremental(
  units: UnitTable,
  edges: UnitEdges,
  config: Config,
  previous: NonNullable<AnalysisInput['previous']>,
): Result | null {
  const n = units.count;
  const own = (rec: Record<string, string>, key: string): string | undefined =>
    (Object.prototype.hasOwnProperty.call(rec, key) ? rec[key] : undefined);

  // District per unit: the previous one where it still names a known city.
  const district = new Array<string | undefined>(n);
  let known = 0;
  for (let u = 0; u < n; u++) {
    const d = own(previous.unitDistrict, units.ids[u]);
    if (d !== undefined && own(previous.districtCity, d) !== undefined) { district[u] = d; known++; }
  }
  const maxNew = (config.clustering as { incrementalMaxNew?: number }).incrementalMaxNew ?? DEFAULT_MAX_NEW;
  if (known === 0 || (n - known) / n > maxNew) return null;

  if (known < n) {
    // New units in path order, so the outcome does not depend on the order units arrive in.
    const fresh: number[] = [];
    for (let u = 0; u < n; u++) if (district[u] === undefined) fresh.push(u);
    fresh.sort((a, b) => comparePaths(units.ids[a], units.ids[b]));
    const isFresh = new Uint8Array(n);
    for (const u of fresh) isFresh[u] = 1;

    // Edges touching a new unit, by that unit.
    const touching = new Map<number, number[]>();
    for (let e = 0; e < edges.count; e++) {
      const s = edges.src[e], d = edges.dst[e];
      if (s === d) continue;
      if (isFresh[s]) { const a = touching.get(s); if (a) a.push(e); else touching.set(s, [e]); }
      if (isFresh[d]) { const a = touching.get(d); if (a) a.push(e); else touching.set(d, [e]); }
    }
    const byConnection = (u: number): string | undefined => {
      const es = touching.get(u);
      if (!es) return undefined;
      const score = new Map<string, number>();
      for (const e of es) {
        const other = edges.src[e] === u ? edges.dst[e] : edges.src[e];
        const d = district[other];
        if (d === undefined) continue;
        score.set(d, (score.get(d) ?? 0) + edges.weight[e] * edges.confidence[e]);
      }
      let best: string | undefined, top = 0;
      for (const [d, w] of score) if (w > top || (w === top && best !== undefined && comparePaths(d, best) < 0)) { best = d; top = w; }
      return best;
    };
    // Two passes: a new unit connected only to other new units is placed once they are.
    for (let pass = 0; pass < 2; pass++) for (const u of fresh) if (district[u] === undefined) district[u] = byConnection(u);

    // The rest go where their directory's files are. Counts per directory and per ancestor, from
    // the units placed so far.
    let left = 0;
    for (const u of fresh) if (district[u] === undefined) left++;
    if (left > 0) {
      const perDir = new Map<string, Map<string, number>>();
      const bump = (dir: string, d: string) => {
        let m = perDir.get(dir);
        if (!m) perDir.set(dir, (m = new Map()));
        m.set(d, (m.get(d) ?? 0) + 1);
      };
      for (let u = 0; u < n; u++) {
        const d = district[u];
        if (d === undefined) continue;
        for (let dir = parentDir(units.ids[u]); ; dir = parentDir(dir)) { bump(dir, d); if (dir === '') break; }
      }
      for (const u of fresh) {
        if (district[u] !== undefined) continue;
        for (let dir = parentDir(units.ids[u]); ; dir = parentDir(dir)) {
          const m = perDir.get(dir);
          if (m) {
            let best: string | undefined, top = 0;
            for (const [d, c] of m) if (c > top || (c === top && best !== undefined && comparePaths(d, best) < 0)) { best = d; top = c; }
            district[u] = best;
            break;
          }
          if (dir === '') break;
        }
        if (district[u] === undefined) return null; // cannot happen while any unit is known
      }
    }
  }

  const usedDistricts = new Set<string>();
  for (let u = 0; u < n; u++) usedDistricts.add(district[u]!);
  const districts = [...usedDistricts].map((id) => ({
    id, city: previous.districtCity[id], name: own(previous.districtName, id) || lastSegment(id),
  }));
  const usedCities = new Set(districts.map((d) => d.city));
  const cities = [...usedCities].map((id) => ({ id, name: own(previous.cityName, id) || lastSegment(id) }));
  districts.sort((x, y) => comparePaths(x.id, y.id));
  cities.sort((x, y) => comparePaths(x.id, y.id));
  return { unitDistrict: district as string[], districts, cities };
}

/** 'a/b/c.ts' → 'a/b'; a root-level path → ''. */
function parentDir(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut < 0 ? '' : path.slice(0, cut);
}

function lastSegment(id: string): string {
  const cut = id.lastIndexOf('/');
  return cut < 0 ? id : id.slice(cut + 1);
}
