// Properties of clustering that must hold on any input (PLAN.md §6.6), checked over a family of
// seeded graphs of different shapes rather than on one example. Nothing here asserts an exact
// partition, name or count: bounds are read from the config that was passed in.
import { describe, expect, it } from 'vitest';
import { config, type Config } from '../../config';
import type { AnalysisInput } from '../../contracts/pipeline';
import { mulberry32 } from '../../shared';
import type { UnitEdges } from '../edges';
import type { UnitTable } from '../units';
import { cluster, type ClusterResult } from './index';

type Previous = NonNullable<AnalysisInput['previous']>;
interface Repo { name: string; paths: string[]; pairs: [string, string][] }

function unitTable(paths: string[]): UnitTable {
  return {
    count: paths.length, ids: paths, primaryFile: paths,
    fileCount: paths.map(() => 1), loc: paths.map(() => 10), bytes: paths.map(() => 100), lang: paths.map(() => 'ts'),
    fileUnit: Int32Array.from(paths, (_, i) => i), unitOfFile: new Map(paths.map((p, i) => [p, i])),
  };
}

/** Edges by path; a pair naming a path that is not in `paths` is left out, duplicates are folded. */
function unitEdges(paths: string[], pairs: [string, string][]): UnitEdges {
  const index = new Map(paths.map((p, i) => [p, i]));
  const seen = new Set<string>();
  const kept: [number, number][] = [];
  for (const [s, d] of pairs) {
    const a = index.get(s), b = index.get(d);
    if (a === undefined || b === undefined || a === b || seen.has(`${a}>${b}`)) continue;
    seen.add(`${a}>${b}`);
    kept.push([a, b]);
  }
  kept.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out: UnitEdges = {
    count: kept.length,
    src: Int32Array.from(kept, (p) => p[0]), dst: Int32Array.from(kept, (p) => p[1]),
    kind: kept.map(() => 'import'), weight: new Float64Array(kept.length).fill(1), confidence: new Float64Array(kept.length).fill(1),
    mechanism: kept.map(() => ''), symbols: kept.map(() => ''), fanIn: new Int32Array(paths.length), fanOut: new Int32Array(paths.length),
  };
  for (const [s, d] of kept) { out.fanOut[s]++; out.fanIn[d]++; }
  return out;
}

function run(repo: Repo, cfg: Config = config, previous?: Previous): ClusterResult {
  const paths = [...repo.paths].sort();
  return cluster(unitTable(paths), unitEdges(paths, repo.pairs), cfg, previous, 'demo');
}
/** unit path → district id, for a result of `run` (which sorts the paths). */
function districtOf(repo: Repo, r: ClusterResult): Map<string, string> {
  return new Map([...repo.paths].sort().map((p, i) => [p, r.unitDistrict[i]]));
}

const pad = (k: number) => String(k).padStart(3, '0');
const folderOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));
const pick = <T>(rnd: () => number, items: readonly T[]): T => items[Math.floor(rnd() * items.length)];

// ---- graph shapes ----

/** Packages of folders of files; a file imports mostly inside its folder, some inside its package, rarely anywhere. */
function planted(seed: number, groups = 8, subs = 3, per = 12, orphans = 2): Repo {
  const rnd = mulberry32(seed);
  const paths: string[] = [], pairs: [string, string][] = [];
  const file = (g: number, s: number, f: number) => `pkg${pad(g)}/mod${pad(s)}/f${pad(f)}.ts`;
  for (let g = 0; g < groups; g++) for (let s = 0; s < subs; s++) {
    for (let f = 0; f < per; f++) {
      paths.push(file(g, s, f));
      for (let k = 0; k < 5; k++) pairs.push([file(g, s, f), file(g, s, Math.floor(rnd() * per))]);
      for (let k = 0; k < 2; k++) pairs.push([file(g, s, f), file(g, Math.floor(rnd() * subs), Math.floor(rnd() * per))]);
      if (rnd() < 0.1) pairs.push([file(g, s, f), file(Math.floor(rnd() * groups), Math.floor(rnd() * subs), Math.floor(rnd() * per))]);
    }
    for (let o = 0; o < orphans; o++) paths.push(`pkg${pad(g)}/mod${pad(s)}/note${o}.md`);
  }
  return { name: `planted(${seed})`, paths, pairs };
}

/** A random folder tree with files scattered over it and imports with no regard for the folders. */
function scattered(seed: number, files = 260, edges = 700): Repo {
  const rnd = mulberry32(seed);
  const dirs = ['src'];
  for (let i = 0; i < 30; i++) dirs.push(`${pick(rnd, dirs)}/d${i}`);
  const paths = Array.from({ length: files }, (_, i) => `${pick(rnd, dirs)}/f${pad(i)}.ts`);
  const pairs = Array.from({ length: edges }, (): [string, string] => [pick(rnd, paths), pick(rnd, paths)]);
  return { name: `scattered(${seed})`, paths, pairs };
}

/** Packages that all import one utility file, and little else across packages. */
function hub(seed: number): Repo {
  const repo = planted(seed, 6, 2, 10, 0);
  repo.paths.push('shared/log.ts');
  for (const p of repo.paths) if (p !== 'shared/log.ts') repo.pairs.push([p, 'shared/log.ts']);
  return { ...repo, name: `hub(${seed})` };
}

/** Nothing but files in folders: docs, data, config. */
function noEdges(seed: number): Repo {
  const rnd = mulberry32(seed);
  const paths: string[] = [];
  for (let d = 0; d < 9; d++) for (let f = 0, n = 2 + Math.floor(rnd() * 30); f < n; f++) paths.push(`docs/part${d}/page${pad(f)}.md`);
  for (let f = 0; f < 4; f++) paths.push(`top${f}.md`);
  return { name: `noEdges(${seed})`, paths, pairs: [] };
}

/** One flat directory of many files, loosely chained. */
function flat(seed: number, files = 300): Repo {
  const rnd = mulberry32(seed);
  const paths = Array.from({ length: files }, (_, i) => `lib/f${pad(i)}.ts`);
  const pairs: [string, string][] = [];
  for (let i = 1; i < files; i++) if (rnd() < 0.7) pairs.push([paths[i], paths[Math.max(0, i - 1 - Math.floor(rnd() * 4))]]);
  return { name: `flat(${seed})`, paths, pairs };
}

/** Many folders of two or three files, each a little island. */
function islands(seed: number): Repo {
  const rnd = mulberry32(seed);
  const paths: string[] = [], pairs: [string, string][] = [];
  for (let d = 0; d < 70; d++) {
    const n = 2 + Math.floor(rnd() * 2);
    for (let f = 0; f < n; f++) { paths.push(`app/feature${pad(d)}/f${f}.ts`); if (f > 0) pairs.push([`app/feature${pad(d)}/f${f}.ts`, `app/feature${pad(d)}/f0.ts`]); }
  }
  return { name: `islands(${seed})`, paths, pairs };
}

/** Every file imports every other: no structure to find. */
function clique(n = 40): Repo {
  const paths = Array.from({ length: n }, (_, i) => `core/f${pad(i)}.ts`);
  const pairs: [string, string][] = [];
  for (const a of paths) for (const b of paths) if (a !== b) pairs.push([a, b]);
  return { name: `clique(${n})`, paths, pairs };
}

function tiny(n: number): Repo {
  const paths = Array.from({ length: n }, (_, i) => (i % 2 ? `src/f${i}.ts` : `f${i}.ts`));
  return { name: `tiny(${n})`, paths, pairs: paths.slice(1).map((p): [string, string] => [p, paths[0]]) };
}

const REPOS: Repo[] = [
  planted(1), planted(2), planted(3, 12, 4, 10, 1), scattered(4), scattered(5, 120, 150), hub(6), noEdges(7), noEdges(8),
  flat(9), flat(10, 90), islands(11), clique(), tiny(1), tiny(2), tiny(3), tiny(7),
];

// ---- the properties ----

/** What must be true of any result: a total, nested, non-empty hierarchy with unique ids. */
function expectWellFormed(repo: Repo, r: ClusterResult, cfg: Config): void {
  const label = repo.name;
  expect(r.unitDistrict.length, label).toBe(repo.paths.length);
  const districtIds = r.districts.map((d) => d.id), cityIds = r.cities.map((c) => c.id);
  expect(new Set(districtIds).size, `${label}: district ids are unique`).toBe(districtIds.length);
  expect(new Set(cityIds).size, `${label}: city ids are unique`).toBe(cityIds.length);
  // No empty district: the districts are exactly the ones units name. No empty city: likewise for districts.
  expect(new Set(r.unitDistrict), `${label}: districts in use`).toEqual(new Set(districtIds));
  expect(new Set(r.districts.map((d) => d.city)), `${label}: cities in use`).toEqual(new Set(cityIds));
  // Nesting: a district belongs to one city (it is a field, so that is a matter of ids being unique),
  // and so every unit has exactly one city through its district.
  for (const d of r.districts) expect(d.id !== '' && d.city !== '' && d.name !== '', `${label}: ${d.id}`).toBe(true);
  for (const c of r.cities) expect(c.id !== '' && c.name !== '', `${label}: ${c.id}`).toBe(true);
  // The city count stays inside the config's bounds (a repo with fewer units than minCities cannot reach it).
  const c = cfg.clustering;
  expect(r.cities.length, `${label}: cities`).toBeLessThanOrEqual(c.maxCities);
  expect(r.cities.length, `${label}: cities`).toBeGreaterThanOrEqual(Math.min(1, repo.paths.length));
  expect(r.districts.length, `${label}: districts`).toBeGreaterThanOrEqual(r.cities.length);
}

function shuffled(repo: Repo, seed: number): Repo {
  const rnd = mulberry32(seed);
  const mix = <T>(items: T[]): T[] => {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
    return out;
  };
  return { name: repo.name, paths: mix(repo.paths), pairs: mix(repo.pairs) };
}

function previousOf(repo: Repo, r: ClusterResult, incremental: boolean): Previous {
  const previous: Previous = { unitDistrict: {}, districtCity: {}, districtName: {}, cityName: {}, incremental };
  for (const [path, district] of districtOf(repo, r)) previous.unitDistrict[path] = district;
  for (const d of r.districts) { previous.districtCity[d.id] = d.city; previous.districtName[d.id] = d.name; }
  for (const c of r.cities) previous.cityName[c.id] = c.name;
  return previous;
}

describe('clustering properties', () => {
  it('always returns a total, nested hierarchy with no empty district or city, within the city bounds', () => {
    for (const repo of REPOS) expectWellFormed(repo, run(repo), config);
  });

  it('holds the same properties for another seed and for other count bounds', () => {
    const c = config.clustering;
    const variants: Config[] = [
      { ...config, clustering: { ...c, seed: c.seed + 1 } },
      { ...config, clustering: { ...c, seed: c.seed + 12345 } },
      { ...config, clustering: { ...c, maxCities: 3 } },
      { ...config, clustering: { ...c, minCities: 5, maxCities: 6 } },
    ];
    for (const cfg of variants) for (const repo of REPOS) expectWellFormed(repo, run(repo, cfg), cfg);
  });

  it('keeps the city count between minCities and maxCities when the repo has that much structure', () => {
    // Twelve packages with little between them: any count from 1 to 12 is there to be found.
    const repo = planted(21, 12, 3, 12, 0);
    const c = config.clustering;
    for (const [minCities, maxCities] of [[1, 2], [3, 4], [6, 6], [8, 12]]) {
      const r = run(repo, { ...config, clustering: { ...c, minCities, maxCities } });
      expect(r.cities.length, `${minCities}..${maxCities}`).toBeGreaterThanOrEqual(minCities);
      expect(r.cities.length, `${minCities}..${maxCities}`).toBeLessThanOrEqual(maxCities);
    }
  });

  it('gives the same result for the same input and seed, whatever order the input arrives in', () => {
    for (const repo of REPOS) {
      const first = run(repo);
      expect(run(repo), repo.name).toEqual(first);
      // `run` sorts the units, as analyze does; the edge list is built from pairs in another order.
      const again = run(shuffled(repo, 99));
      expect(again, repo.name).toEqual(first);
    }
  });

  it('does not depend on the order of the unit table either', () => {
    for (const repo of [planted(1), scattered(4), noEdges(7), flat(10, 90)]) {
      const first = run(repo);
      const mixed = shuffled(repo, 7);
      // the table itself in shuffled order: membership is compared by path
      const r = cluster(unitTable(mixed.paths), unitEdges(mixed.paths, mixed.pairs), config, undefined, 'demo');
      expect(r.cities, repo.name).toEqual(first.cities);
      expect(r.districts, repo.name).toEqual(first.districts);
      expect(new Map(mixed.paths.map((p, i) => [p, r.unitDistrict[i]])), repo.name).toEqual(districtOf(repo, first));
    }
  });

  it('puts a file with no edges with the code of its folder', () => {
    for (const repo of [planted(1), planted(2), planted(3, 12, 4, 10, 1), planted(31, 5, 2, 20, 4)]) {
      const district = districtOf(repo, run(repo));
      const codeDistricts = new Map<string, Set<string>>();
      for (const p of repo.paths) if (p.endsWith('.ts')) codeDistricts.set(folderOf(p), (codeDistricts.get(folderOf(p)) ?? new Set<string>()).add(district.get(p)!));
      for (const p of repo.paths) if (p.endsWith('.md')) expect(codeDistricts.get(folderOf(p))!.has(district.get(p)!), `${repo.name}: ${p}`).toBe(true);
    }
  });

  it('keeps a folder of nothing but unconnected files in one city', () => {
    for (const repo of [noEdges(7), noEdges(8)]) {
      const r = run(repo);
      const cityOfDistrict = new Map(r.districts.map((d) => [d.id, d.city]));
      const cities = new Map<string, Set<string>>();
      for (const [path, district] of districtOf(repo, r)) cities.set(folderOf(path), (cities.get(folderOf(path)) ?? new Set<string>()).add(cityOfDistrict.get(district)!));
      for (const [folder, set] of cities) expect(set.size, `${repo.name}: ${folder}`).toBe(1);
    }
  });

  it('an Update keeps every existing unit in its district, whatever was added, removed or rewired', () => {
    for (const repo of [planted(1), planted(2), scattered(4), hub(6), noEdges(7), flat(9), islands(11)]) {
      const first = run(repo);
      const previous = previousOf(repo, first, true);
      const rnd = mulberry32(repo.paths.length);
      // Some files go, some arrive (beside existing files, in new folders, with and without imports), some imports change.
      const removed = new Set(repo.paths.filter(() => rnd() < 0.05));
      const kept = repo.paths.filter((p) => !removed.has(p));
      const fresh: string[] = [];
      const pairs = repo.pairs.filter(() => rnd() > 0.1);
      const arrivals = Math.max(1, Math.floor(kept.length * config.clustering.incrementalMaxNew * 0.5));
      for (let i = 0; i < arrivals; i++) {
        const path = rnd() < 0.7 ? `${folderOf(pick(rnd, kept)) || 'root'}/new${pad(i)}.ts` : `brand/new/place${i % 3}/new${pad(i)}.ts`;
        fresh.push(path);
        if (rnd() < 0.6) for (let k = 0; k < 3; k++) pairs.push(rnd() < 0.5 ? [path, pick(rnd, kept)] : [pick(rnd, kept), path]);
        if (rnd() < 0.2 && fresh.length > 1) pairs.push([path, fresh[0]]);
      }
      for (let k = 0; k < 20; k++) pairs.push([pick(rnd, kept), pick(rnd, kept)]);
      const next: Repo = { name: `${repo.name} updated`, paths: [...kept, ...fresh], pairs };

      const second = run(next, config, previous);
      expectWellFormed(next, second, config);
      const now = districtOf(next, second);
      for (const p of kept) expect(now.get(p), `${next.name}: ${p}`).toBe(previous.unitDistrict[p]);
      // A new unit is placed in a district that was already there, in the city it was in.
      for (const p of fresh) expect(previous.districtCity[now.get(p)!], `${next.name}: ${p}`).toBeDefined();
      for (const d of second.districts) expect(d.city, `${next.name}: ${d.id}`).toBe(previous.districtCity[d.id]);
      // The outcome does not depend on the order the new units arrive in.
      expect(run(shuffled(next, 5), config, previous), next.name).toEqual(second);
    }
  });

  it('an Update that only removes files drops the districts that emptied and moves nothing', () => {
    const repo = planted(2);
    const first = run(repo);
    const previous = previousOf(repo, first, true);
    const gone = first.districts[0].id;
    const was = districtOf(repo, first);
    const next: Repo = { name: 'planted(2) pruned', paths: repo.paths.filter((p) => was.get(p) !== gone), pairs: repo.pairs };
    expect(next.paths.length).toBeLessThan(repo.paths.length);
    const second = run(next, config, previous);
    expectWellFormed(next, second, config);
    expect(second.districts.map((d) => d.id)).not.toContain(gone);
    for (const [path, district] of districtOf(next, second)) expect(district, path).toBe(was.get(path));
  });
});
