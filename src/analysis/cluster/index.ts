// Stage 5 — cities and districts by community detection (PLAN.md §6.6). Package 2A.
//
//   graph.ts      the clustering graph: symmetrised, hub-damped, with directory affinity
//   louvain.ts    Louvain levels from graphology-communities-louvain
//   merge.ts      smallest-into-most-connected merging down to the wanted count
//   balance.ts    the bias against giants: effective count and size-relative merging (no size is capped)
//   refine.ts     a giant is divided where it has real structure of its own, and only there
//   names.ts      names from path segments
//   stableIds.ts  previous ids kept where a community persists
//   incremental.ts  an Update keeps every unit where it was and places only the new ones
//
// Cities: K = clamp(round(citiesPerDecade · log10(files) + cityOffset), minCities, maxCities). The
// coarsest Louvain level is taken (the resolution is raised and Louvain re-run, a few times at most,
// when it has fewer than K communities), pieces that are not really separate are rejoined and giants
// with structure of their own are divided (refine.ts), and the result is merged down to K as the
// effective count sees it (balance.ts), so between K and countSlack · K cities remain; fewer are
// accepted when the graph will not split.
// Districts: the same curve and the same three steps on each city's files, starting from the
// coarsest finer level of the same run that has enough communities inside the city; when no level
// does, or the level is mostly crumbs, Louvain runs again on the city's own subgraph. A city is the
// union of whole communities of the level it was merged from, or of the parts refine.ts divided
// them into, so a finer level restricted to a city can start from fragments of its communities;
// districts are computed per city, so they nest inside it either way.
// An Update (previous.incremental) skips all of this: see incremental.ts.
// Everything is deterministic and independent of the order units and edges arrive in.
import type { Config } from '../../config';
import type { AnalysisInput } from '../../contracts/pipeline';
import type { UnitEdges } from '../edges';
import { comparePaths } from '../order';
import type { UnitTable } from '../units';
import { countLimit, districtBias } from './balance';
import { buildClusterGraph, type ClusterGraph, type EdgeList } from './graph';
import { clusterIncremental, wantsIncremental } from './incremental';
import { louvainLevels } from './louvain';
import { communitySizes, labelCount, mergeDown, type Partition } from './merge';
import { Namer } from './names';
import { mergeCohesive, refineGiants, settleStragglers } from './refine';
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
  /** Names the map's only city, and a city of root-level files. */
  repoName?: string,
) => ClusterResult;

type ClusteringConfig = Config['clustering'];

/** Louvain runs per partition at most: the configured resolution first, then raised by RESOLUTION_STEP each time. */
const MAX_RUNS = 4;
const RESOLUTION_STEP = 2;

/** The count curve of PLAN.md §6.6, before clamping: 50 files → 4, 1,000 → 8, 100,000 → 15 with the defaults. */
export function communityTarget(files: number, perDecade: number, offset: number): number {
  return Math.round(perDecade * Math.log10(Math.max(1, files)) + offset);
}

export const cluster: Cluster = (units, edges, config, previous, repoName = '') => {
  if (units.count === 0) return { unitDistrict: [], districts: [], cities: [] };
  if (previous && wantsIncremental(previous)) {
    const kept = clusterIncremental(units, edges, config, previous);
    if (kept) return kept;
  }
  // Two views of the same nodes: directories whole (cities are formed on this one), and large
  // directories tied in runs (districts are formed on this one, so a big flat directory can become
  // several districts without its files drifting into different cities).
  const graph = buildClusterGraph(units, edges, config.clustering, false);
  const districtGraph = config.clustering.sizeBias > 0 ? buildClusterGraph(units, edges, config.clustering, true) : graph;
  const n = graph.units;
  const { cityOf, cityCount, districtOf, districtCity } = detectCommunities(graph, districtGraph, config.clustering);
  const districtCount = districtCity.length;

  // Communities that persist from the previous run keep their ids, and their names with them.
  let keptDistrict: (string | undefined)[] = new Array(districtCount).fill(undefined);
  let keptCity: (string | undefined)[] = new Array(cityCount).fill(undefined);
  if (previous) {
    const prevDistrict = graph.paths.map((id) => own(previous.unitDistrict, id));
    const prevCity = prevDistrict.map((d) => (d === undefined ? undefined : own(previous.districtCity, d)));
    keptDistrict = matchPrevious(districtOf, districtCount, prevDistrict);
    keptCity = matchPrevious(cityOf, cityCount, prevCity);
  }
  const cityBefore = keptCity.map((id) => (id === undefined || !previous ? undefined : own(previous.cityName, id)));
  const districtBefore = keptDistrict.map((id) => (id === undefined || !previous ? undefined : own(previous.districtName, id)));

  // Names: cities against each other, districts against their siblings; a previous name is reused
  // while it is free.
  const namer = new Namer(graph.paths);
  const cityMembers = groupBy(cityOf, cityCount);
  const districtMembers = groupBy(districtOf, districtCount);
  const cityNames = cityCount === 1 && repoName ? [repoName] : namer.name(cityMembers, repoName, cityBefore);
  const districtsOfCity: number[][] = Array.from({ length: cityCount }, () => []);
  for (let d = 0; d < districtCount; d++) districtsOfCity[districtCity[d]].push(d);
  const districtNames = new Array<string>(districtCount);
  for (let c = 0; c < cityCount; c++) {
    const ds = districtsOfCity[c];
    const names = ds.length === 1 ? [cityNames[c]] : namer.name(ds.map((d) => districtMembers[d]), cityNames[c], ds.map((d) => districtBefore[d]));
    ds.forEach((d, k) => { districtNames[d] = names[k]; });
  }

  // Ids: a fresh id is the name (district: city name / district name).
  const freshDistrict = districtNames.map((name, d) => {
    const city = cityNames[districtCity[d]];
    return name === city ? city : `${city}/${name}`;
  });
  const finalCity = mintIds(cityNames, keptCity);
  const finalDistrict = mintIds(freshDistrict, keptDistrict);

  const cities = finalCity.map((id, c) => ({ id, name: cityNames[c] }));
  const districts = finalDistrict.map((id, d) => ({ id, city: finalCity[districtCity[d]], name: districtNames[d] }));
  cities.sort((x, y) => comparePaths(x.id, y.id));
  districts.sort((x, y) => comparePaths(x.id, y.id));
  const unitDistrict = new Array<string>(n);
  for (let i = 0; i < n; i++) unitDistrict[graph.unitOf[i]] = finalDistrict[districtOf[i]];
  return { unitDistrict, districts, cities };
};

interface Communities {
  /** City per unit node, 0..cityCount-1 in order of first appearance along the paths. */
  cityOf: Int32Array;
  cityCount: number;
  /** District per unit node, numbered across all cities. */
  districtOf: Int32Array;
  /** City per district. */
  districtCity: number[];
}

function detectCommunities(g: ClusterGraph, gd: ClusterGraph, cfg: ClusteringConfig): Communities {
  const minSize = cfg.minDistrictSize;
  const pathOf = (node: number): string | undefined => (node < g.units ? g.paths[node] : undefined);
  let files = 0;
  for (let i = 0; i < g.units; i++) files += g.size[i];

  // Cities. One smaller than a district is not kept.
  const wantCities = Math.max(1, Math.min(
    g.units,
    Math.max(cfg.minCities, Math.min(cfg.maxCities, communityTarget(files, cfg.citiesPerDecade, cfg.cityOffset))),
  ));
  const levels = detect(g.nodes, g, g.size, wantCities, minSize, cfg);
  // Giants with structure of their own are divided first (refine.ts); the merge then works by
  // effective count and size-relative connection (balance.ts), which can leave more than the wanted
  // number standing. maxCities still bounds it.
  const cityLabels = refineGiants(mergeCohesive(levels[levels.length - 1], g, cfg), g, g.size, wantCities, cfg);
  const slack = (cfg as { countSlack?: number }).countSlack;
  // Districts may run further above their curve than cities: a city of thousands of files reads
  // better as two dozen districts than as ten with one of them holding half of it.
  const districtSlack = (cfg as { districtCountSlack?: number }).districtCountSlack ?? 2.5;
  // Lean toward the directory tree when choosing which neighbour a community joins (merge.ts).
  const mergePathBias = (cfg as { mergePathBias?: number }).mergePathBias ?? 0;
  const mergedCities = mergeDown(cityLabels, g, g.size, wantCities, minSize, pathOf, cfg.sizeBias,
    Math.max(wantCities, Math.min(cfg.maxCities, countLimit(wantCities, slack))), false, mergePathBias);
  // Whole blocks have been moved about; now each file goes where most of its connections are.
  const cityOfNode = cfg.sizeBias > 0 ? settleStragglers(mergedCities.labels, g) : mergedCities.labels;
  const cities: Partition = { labels: cityOfNode, count: labelCount(cityOfNode) };

  // Nodes, and the edges inside a city, grouped by city.
  const city = cities.labels;
  const nodeStart = new Int32Array(cities.count + 1);
  for (let i = 0; i < g.nodes; i++) nodeStart[city[i] + 1]++;
  for (let c = 0; c < cities.count; c++) nodeStart[c + 1] += nodeStart[c];
  const cityNodes = new Int32Array(g.nodes);
  const local = new Int32Array(g.nodes);
  const fill = nodeStart.slice(0, cities.count);
  for (let i = 0; i < g.nodes; i++) { local[i] = fill[city[i]] - nodeStart[city[i]]; cityNodes[fill[city[i]]++] = i; }
  const edgeStart = new Int32Array(cities.count + 1);
  for (let e = 0; e < gd.count; e++) if (city[gd.a[e]] === city[gd.b[e]]) edgeStart[city[gd.a[e]] + 1]++;
  for (let c = 0; c < cities.count; c++) edgeStart[c + 1] += edgeStart[c];
  const cityEdges = new Int32Array(edgeStart[cities.count]);
  fill.set(edgeStart.subarray(0, cities.count));
  for (let e = 0; e < gd.count; e++) if (city[gd.a[e]] === city[gd.b[e]]) cityEdges[fill[city[gd.a[e]]]++] = e;

  // Districts, city by city.
  const districtOf = new Int32Array(g.units);
  const districtCity: number[] = [];
  const scratch = new Int32Array(g.nodes).fill(-1);
  for (let c = 0; c < cities.count; c++) {
    const members = cityNodes.subarray(nodeStart[c], nodeStart[c + 1]);
    const size = Float64Array.from(members, (i) => g.size[i]);
    let cityFiles = 0;
    for (let k = 0; k < size.length; k++) cityFiles += size[k];
    const want = Math.min(Math.floor(cityFiles / minSize), communityTarget(cityFiles, cfg.districtsPerDecade, cfg.districtOffset));

    let part: Partition = { labels: new Int32Array(members.length), count: 1 };
    if (want > 1) {
      const count = edgeStart[c + 1] - edgeStart[c];
      const inside: EdgeList = { count, a: new Int32Array(count), b: new Int32Array(count), w: new Float64Array(count) };
      for (let k = 0; k < count; k++) {
        const e = cityEdges[edgeStart[c] + k];
        inside.a[k] = local[gd.a[e]]; inside.b[k] = local[gd.b[e]]; inside.w[k] = gd.w[e];
      }
      const memberPath = (k: number) => pathOf(members[k]);
      const found = fromFinerLevel(levels, members, size, want, minSize, cityFiles, scratch)
        ?? last(detect(members.length, inside, size, want, minSize, cfg));
      const strength = districtBias(cfg);
      const labels = refineGiants(mergeCohesive(found, inside, cfg), inside, size, want, cfg, undefined, 0, strength);
      // Districts: the firmer strength and the sharp merge score, and no settling of stragglers,
      // which inside one city would only gather everything back around its busiest files.
      part = mergeDown(labels, inside, size, want, minSize, memberPath, strength, countLimit(want, districtSlack), true, mergePathBias);
    }
    const base = districtCity.length;
    for (let d = 0; d < part.count; d++) districtCity.push(c);
    for (let k = 0; k < members.length; k++) if (members[k] < g.units) districtOf[members[k]] = base + part.labels[k];
  }
  return dropEmpty(city.subarray(0, g.units), cities.count, districtOf, districtCity);
}

/**
 * Communities are formed over unit nodes and directory hubs alike, and a community can end up
 * holding only hubs: every file of a city moved to where it is more connected, say, and its
 * directory hubs stayed behind. Such a district or city has no unit in it and must not reach the
 * model. Districts no unit belongs to and cities left without a district are removed here, and the
 * rest renumbered in order of first appearance over the units.
 */
function dropEmpty(cityOfUnit: Int32Array, cityCount: number, districtOfUnit: Int32Array, districtCity: number[]): Communities {
  const districtMap = new Int32Array(districtCity.length).fill(-1);
  const cityMap = new Int32Array(cityCount).fill(-1);
  const keptDistrictCity: number[] = [];
  let cities = 0;
  const districtOf = new Int32Array(districtOfUnit.length);
  const cityOf = new Int32Array(cityOfUnit.length);
  for (let u = 0; u < districtOfUnit.length; u++) {
    const d = districtOfUnit[u];
    // a unit's city is its district's city; the two labellings agree by construction
    const c = districtCity[d];
    if (cityMap[c] < 0) cityMap[c] = cities++;
    if (districtMap[d] < 0) { districtMap[d] = keptDistrictCity.length; keptDistrictCity.push(cityMap[c]); }
    districtOf[u] = districtMap[d];
    cityOf[u] = cityMap[c];
  }
  return { cityOf, cityCount: cities, districtOf, districtCity: keptDistrictCity };
}

/**
 * Louvain levels whose coarsest level has at least `target` communities of `minSize` files, raising
 * the resolution while it has not; failing that, the run that came closest.
 */
function detect(
  nodes: number, edges: EdgeList, nodeSize: ArrayLike<number>, target: number, minSize: number, cfg: ClusteringConfig,
): Int32Array[] {
  let best: Int32Array[] | null = null;
  let bestViable = -1;
  let resolution = cfg.resolution;
  for (let run = 0; run < MAX_RUNS; run++, resolution *= RESOLUTION_STEP) {
    const levels = louvainLevels(nodes, edges, resolution, cfg.seed);
    let viable = 0;
    for (const s of communitySizes(last(levels), nodeSize)) if (s >= minSize) viable++;
    if (viable > bestViable) { best = levels; bestViable = viable; }
    if (viable >= target || edges.count === 0) break;
  }
  return best!;
}

/**
 * A city's districts from the run that made the cities: the coarsest level below the city level
 * with at least `want` communities of `minSize` files inside the city. Null when there is none or
 * when most of the city's files sit in communities smaller than that (the level is degenerate).
 */
function fromFinerLevel(
  levels: Int32Array[], members: Int32Array, size: Float64Array, want: number, minSize: number, cityFiles: number,
  scratch: Int32Array,
): Int32Array | null {
  for (let l = levels.length - 2; l >= 0; l--) {
    // The level restricted to the city, renumbered from 0. `scratch` is all -1 on entry and on exit.
    const level = levels[l];
    const labels = new Int32Array(members.length);
    let count = 0;
    for (let k = 0; k < members.length; k++) {
      const c = level[members[k]];
      if (scratch[c] < 0) scratch[c] = count++;
      labels[k] = scratch[c];
    }
    for (let k = 0; k < members.length; k++) scratch[level[members[k]]] = -1;

    let viable = 0, crumbs = 0;
    for (const s of communitySizes(labels, size)) if (s >= minSize) viable++; else crumbs += s;
    if (viable >= want) return crumbs * 2 <= cityFiles ? labels : null;
  }
  return null;
}

/** Members per group, in node order. */
function groupBy(groupOf: Int32Array, groupCount: number): number[][] {
  const members: number[][] = Array.from({ length: groupCount }, () => []);
  for (let i = 0; i < groupOf.length; i++) members[groupOf[i]].push(i);
  return members;
}

function last<T>(items: readonly T[]): T {
  return items[items.length - 1];
}

function own(record: Record<string, string>, key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}
