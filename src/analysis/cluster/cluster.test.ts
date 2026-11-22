import { UndirectedGraph } from 'graphology';
import louvain from 'graphology-communities-louvain';
import { describe, expect, it } from 'vitest';
import { config } from '../../config';
import type { AnalysisInput } from '../../contracts/pipeline';
import { mulberry32, now } from '../../shared';
import type { UnitEdges } from '../edges';
import type { UnitTable } from '../units';
import { buildClusterGraph } from './graph';
import { cluster, communityTarget, type ClusterResult } from './index';
import { louvainLevels } from './louvain';
import { labelCount } from './merge';

function unitTable(paths: string[]): UnitTable {
  return {
    count: paths.length, ids: paths, primaryFile: paths,
    fileCount: paths.map(() => 1), loc: paths.map(() => 10), bytes: paths.map(() => 100), lang: paths.map(() => 'ts'),
    fileUnit: Int32Array.from(paths, (_, i) => i), unitOfFile: new Map(paths.map((p, i) => [p, i])),
  };
}

function unitEdges(n: number, pairs: [number, number][]): UnitEdges {
  const out: UnitEdges = {
    count: pairs.length,
    src: Int32Array.from(pairs, (p) => p[0]), dst: Int32Array.from(pairs, (p) => p[1]),
    kind: pairs.map(() => 'import'), weight: new Float64Array(pairs.length).fill(1), confidence: new Float64Array(pairs.length).fill(1),
    mechanism: pairs.map(() => ''), symbols: pairs.map(() => ''), fanIn: new Int32Array(n), fanOut: new Int32Array(n),
  };
  for (const [s, d] of pairs) { out.fanOut[s]++; out.fanIn[d]++; }
  return out;
}

/**
 * A planted hierarchy: `groups` packages of `subs` folders of `per` files. A file imports `inside`
 * files of its own folder, `near` files of its package and, with probability `across`, one file
 * anywhere. Every folder also holds `orphans` files with no edges at all.
 */
function planted(groups: number, subs: number, per: number, seed: number, { inside = 6, near = 2, across = 0.15, orphans = 0 } = {}) {
  const rnd = mulberry32(seed);
  const pad = (k: number) => String(k).padStart(3, '0');
  const paths: string[] = [];
  for (let g = 0; g < groups; g++) for (let s = 0; s < subs; s++) for (let f = 0; f < per; f++) paths.push(`pkg${pad(g)}/mod${pad(s)}/f${pad(f)}.ts`);
  const code = paths.length;
  for (let g = 0; g < groups; g++) for (let s = 0; s < subs; s++) for (let f = 0; f < orphans; f++) paths.push(`pkg${pad(g)}/mod${pad(s)}/note${f}.md`);
  const seen = new Set<number>();
  const pairs: [number, number][] = [];
  const link = (s: number, d: number) => {
    if (s === d || seen.has(s * code + d)) return;
    seen.add(s * code + d);
    pairs.push([s, d]);
  };
  for (let s = 0; s < code; s++) {
    const folder = Math.floor(s / per) * per, pkg = Math.floor(s / (per * subs)) * per * subs;
    for (let k = 0; k < inside; k++) link(s, folder + Math.floor(rnd() * per));
    for (let k = 0; k < near; k++) link(s, pkg + Math.floor(rnd() * per * subs));
    if (rnd() < across) link(s, Math.floor(rnd() * code));
  }
  return { paths, pairs, code };
}

/** 'pkg001/mod002/f003.ts' → 'pkg001/mod002'. */
const folderOf = (path: string) => path.slice(0, path.lastIndexOf('/'));

function run(paths: string[], pairs: [number, number][], previous?: AnalysisInput['previous'], cfg = config): ClusterResult {
  return cluster(unitTable(paths), unitEdges(paths.length, pairs), cfg, previous, 'demo');
}

/** unit id → district id, and district id → city id. */
function membership(paths: string[], r: ClusterResult) {
  const district = new Map(paths.map((p, i) => [p, r.unitDistrict[i]]));
  const cityOfDistrict = new Map(r.districts.map((d) => [d.id, d.city]));
  const city = new Map(paths.map((p, i) => [p, cityOfDistrict.get(r.unitDistrict[i])!]));
  return { district, city };
}

describe('graphology-communities-louvain', () => {
  it('returns a dendrogram of per-node levels in insertion order, identity first, each nested in the next', () => {
    // Keys are inserted in a scrambled order, to tell "indexed by insertion order" from "indexed by key".
    const rnd = mulberry32(3);
    const groups = 9, per = 12, n = groups * per;
    const keys = Array.from({ length: n }, (_, i) => `k${(i * 37) % n}`);
    const graph = new UndirectedGraph();
    for (const key of keys) graph.addNode(key);
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const gi = Math.floor(i / per), gj = Math.floor(j / per);
      const p = gi === gj ? 0.6 : Math.floor(gi / 3) === Math.floor(gj / 3) ? 0.08 : 0.004;
      if (rnd() < p) graph.addEdge(keys[i], keys[j], { weight: 1 });
    }
    const out = louvain.detailed(graph, { rng: mulberry32(1), getEdgeWeight: 'weight' });
    const levels = out.dendrogram;

    expect(levels.length).toBeGreaterThanOrEqual(2);
    for (const level of levels) expect(level.length).toBe(n);
    expect(Array.from(levels[0])).toEqual(Array.from({ length: n }, (_, i) => i));
    // Level k gives the community of ORIGINAL node i (no composing), numbered 0..count-1.
    for (let k = 1; k < levels.length; k++) {
      const count = new Set(levels[k]).size;
      expect(Math.max(...levels[k])).toBe(count - 1);
      expect(count).toBeLessThan(new Set(levels[k - 1]).size);
      const coarse = new Map<number, number>();
      for (let i = 0; i < n; i++) {
        const fine = levels[k - 1][i];
        if (!coarse.has(fine)) coarse.set(fine, levels[k][i]);
        expect(levels[k][i]).toBe(coarse.get(fine));
      }
    }
    // The last level is the final partition, read by insertion position.
    const final = levels[levels.length - 1];
    expect(new Set(final).size).toBe(out.count);
    keys.forEach((key, i) => expect(final[i]).toBe(out.communities[key]));

    // No edges: no dendrogram at all.
    const empty = new UndirectedGraph();
    empty.addNode('a');
    empty.addNode('b');
    expect(louvain.detailed(empty).dendrogram).toBeNull();
  });

  it('finds at least as many communities at a higher resolution', () => {
    const { paths, pairs } = planted(12, 4, 20, 7);
    const g = buildClusterGraph(unitTable(paths), unitEdges(paths.length, pairs), config.clustering);
    const top = (resolution: number) => {
      const levels = louvainLevels(g.nodes, g, resolution, config.clustering.seed);
      return labelCount(levels[levels.length - 1]);
    };
    const base = top(config.clustering.resolution);
    expect(top(config.clustering.resolution * 4)).toBeGreaterThanOrEqual(base);
    expect(top(config.clustering.resolution * 16)).toBeGreaterThan(base);
  });
});

describe('cluster', () => {
  const c = config.clustering;

  it('nests districts inside cities, with a city count on the config curve', () => {
    const { paths, pairs } = planted(12, 4, 20, 11);
    const r = run(paths, pairs);
    const want = Math.max(c.minCities, Math.min(c.maxCities, communityTarget(paths.length, c.citiesPerDecade, c.cityOffset)));
    expect(Math.abs(r.cities.length - want)).toBeLessThanOrEqual(2);

    // Every unit has a district, every district a city; nothing is empty; ids are unique.
    const cityIds = new Set(r.cities.map((x) => x.id));
    const districtIds = new Set(r.districts.map((x) => x.id));
    expect(cityIds.size).toBe(r.cities.length);
    expect(districtIds.size).toBe(r.districts.length);
    expect(new Set(r.unitDistrict)).toEqual(districtIds);
    expect(new Set(r.districts.map((d) => d.city))).toEqual(cityIds);
    expect(r.districts.length).toBeGreaterThan(r.cities.length);

    // A planted package is one community: all of its files share a city.
    const { city } = membership(paths, r);
    for (const p of paths) expect(city.get(p)).toBe(city.get(`${p.slice(0, p.indexOf('/'))}/mod000/f000.ts`));

    // No district is undersized, and names are present and unique among siblings.
    const sizes = new Map<string, number>();
    for (const d of r.unitDistrict) sizes.set(d, (sizes.get(d) ?? 0) + 1);
    for (const s of sizes.values()) expect(s).toBeGreaterThanOrEqual(c.minDistrictSize);
    expect(new Set(r.cities.map((x) => x.name)).size).toBe(r.cities.length);
    for (const x of [...r.cities, ...r.districts]) expect(x.name.length).toBeGreaterThan(0);
    for (const id of cityIds) {
      const names = r.districts.filter((d) => d.city === id).map((d) => d.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it('gives the same result for the same input, in any input order', () => {
    const { paths, pairs } = planted(10, 3, 14, 5, { orphans: 2 });
    const first = run(paths, pairs);
    expect(run(paths, pairs)).toEqual(first);

    const rnd = mulberry32(99);
    const order = paths.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    const position = new Int32Array(order.length);
    order.forEach((old, at) => { position[old] = at; });
    const shuffledPaths = order.map((old) => paths[old]);
    const shuffledPairs = pairs.map(([s, d]): [number, number] => [position[s], position[d]]).reverse();
    const second = run(shuffledPaths, shuffledPairs);

    expect(second.cities).toEqual(first.cities);
    expect(second.districts).toEqual(first.districts);
    expect(membership(shuffledPaths, second).district).toEqual(membership(paths, first).district);
  });

  it('puts files with no edges in the community of their folder', () => {
    const { paths, pairs, code } = planted(8, 3, 12, 21, { orphans: 2 });
    // A folder of nothing but orphans still lands somewhere, together.
    const docs = ['docs/guide/a.md', 'docs/guide/b.md', 'docs/guide/c.md', 'docs/intro.md'];
    const all = [...paths, ...docs];
    const r = run(all, pairs);
    const { district } = membership(all, r);
    const codeDistricts = new Map<string, Set<string>>();
    for (const p of paths.slice(0, code)) codeDistricts.set(folderOf(p), (codeDistricts.get(folderOf(p)) ?? new Set()).add(district.get(p)!));
    for (const p of paths.slice(code)) expect(codeDistricts.get(folderOf(p))!.has(district.get(p)!)).toBe(true);
    expect(new Set(docs.map((p) => district.get(p))).size).toBe(1);
  });

  it('keeps previous city and district ids where a community persists', () => {
    const { paths, pairs } = planted(10, 3, 14, 5);
    const first = run(paths, pairs);
    const old = (id: string) => `old:${id}`;
    const previous: NonNullable<AnalysisInput['previous']> = { unitDistrict: {}, districtCity: {}, districtName: {}, cityName: {} };
    paths.forEach((p, i) => { previous.unitDistrict[p] = old(first.unitDistrict[i]); });
    for (const d of first.districts) { previous.districtCity[old(d.id)] = old(d.city); previous.districtName[old(d.id)] = d.name; }
    for (const x of first.cities) previous.cityName[old(x.id)] = x.name;

    // The same repo plus one new file in an existing folder.
    const grown = [...paths, 'pkg003/mod000/new.ts'];
    const at = paths.indexOf('pkg003/mod000/f000.ts');
    const next = run(grown, [...pairs, [paths.length, at], [paths.length, at + 1]], previous);
    expect(next.cities.map((x) => x.id).sort()).toEqual(first.cities.map((x) => old(x.id)).sort());
    const districtIds = new Set(next.districts.map((d) => d.id));
    for (const d of first.districts) expect(districtIds.has(old(d.id))).toBe(true);
    const kept = paths.filter((p, i) => next.unitDistrict[i] === old(first.unitDistrict[i])).length;
    expect(kept / paths.length).toBeGreaterThan(0.9);
  });

  it('handles the edge cases: no units, one unit, no edges and no affinity', () => {
    expect(cluster(unitTable([]), unitEdges(0, []), config)).toEqual({ unitDistrict: [], districts: [], cities: [] });
    const one = run(['README.md'], []);
    expect(one.cities).toEqual([{ id: 'demo', name: 'demo' }]);
    expect(one.unitDistrict).toEqual([one.districts[0].id]);

    const bare = { ...config, clustering: { ...c, directoryAffinity: 0 } };
    const paths = Array.from({ length: 60 }, (_, i) => `${['a', 'b', 'c'][i % 3]}/x/f${i}.ts`);
    const r = run(paths, [], undefined, bare);
    // With nothing but paths to go on, communities follow the folders: no city mixes two of them.
    const { city } = membership(paths, r);
    const folders = new Map<string, Set<string>>();
    for (const p of paths) folders.set(city.get(p)!, (folders.get(city.get(p)!) ?? new Set()).add(p[0]));
    expect(folders.size).toBe(r.cities.length);
    for (const set of folders.values()) expect(set.size).toBe(1);
  });

  it('prints its timing at 10k units / 100k edges', () => {
    const { paths, pairs } = planted(40, 10, 25, 3, { inside: 7, near: 3, across: 0.5 });
    const table = unitTable(paths), edges = unitEdges(paths.length, pairs);
    const t0 = now();
    const r = cluster(table, edges, config, undefined, 'demo');
    console.log(`cluster: ${paths.length} units, ${pairs.length} edges → ${r.cities.length} cities, ${r.districts.length} districts in ${(now() - t0).toFixed(0)} ms`);
    expect(r.unitDistrict.length).toBe(paths.length);
  });
});
