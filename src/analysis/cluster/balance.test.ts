// The bias against mega-districts and megacities (balance.ts): it must spread sizes out without
// ever capping one. Light on purpose: sizes and counts are tunable, so the tests compare runs with
// and without the bias instead of asserting numbers.
import { describe, expect, it } from 'vitest';
import { config } from '../../config';
import { mulberry32 } from '../../shared';
import type { UnitEdges } from '../edges';
import type { UnitTable } from '../units';
import { effectiveCount, evenShareCount } from './balance';
import { cluster, type ClusterResult } from './index';
import { settleStragglers } from './refine';

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

const withBias = (sizeBias: number) => ({ ...config, clustering: { ...config.clustering, sizeBias } });

function sizes(r: ClusterResult): { districts: number[]; cities: number[] } {
  const cityOf = new Map(r.districts.map((d) => [d.id, d.city]));
  const d = new Map<string, number>(), c = new Map<string, number>();
  for (const id of r.unitDistrict) { d.set(id, (d.get(id) ?? 0) + 1); c.set(cityOf.get(id)!, (c.get(cityOf.get(id)!) ?? 0) + 1); }
  return { districts: [...d.values()].sort((a, b) => b - a), cities: [...c.values()].sort((a, b) => b - a) };
}

/**
 * One large package made of `blocks` folders that lean on each other, beside `small` small packages
 * each with a few links into the large one: the shape that turns into a megacity when every small
 * package is merged into its most-connected neighbour.
 */
function lopsided(blocks: number, per: number, small: number, smallPer: number, seed: number) {
  const rnd = mulberry32(seed);
  const pad = (k: number) => String(k).padStart(3, '0');
  const paths: string[] = [];
  for (let b = 0; b < blocks; b++) for (let f = 0; f < per; f++) paths.push(`core/part${pad(b)}/f${pad(f)}.ts`);
  const big = paths.length;
  for (let s = 0; s < small; s++) for (let f = 0; f < smallPer; f++) paths.push(`lib${pad(s)}/f${pad(f)}.ts`);
  const pairs: [number, number][] = [];
  const seen = new Set<string>();
  const link = (a: number, b: number) => { if (a !== b && !seen.has(`${a},${b}`)) { seen.add(`${a},${b}`); pairs.push([a, b]); } };
  for (let i = 0; i < big; i++) {
    const block = Math.floor(i / per) * per;
    for (let k = 0; k < 6; k++) link(i, block + Math.floor(rnd() * per));
    if (rnd() < 0.5) link(i, Math.floor(rnd() * big));
  }
  for (let i = big; i < paths.length; i++) {
    const lib = big + Math.floor((i - big) / smallPer) * smallPer;
    for (let k = 0; k < 4; k++) link(i, lib + Math.floor(rnd() * smallPer));
    if (rnd() < 0.3) link(i, Math.floor(rnd() * big));
  }
  return { paths, pairs };
}

describe('counts that see giants', () => {
  it('equal sizes count as their number; a dominant community counts for little', () => {
    expect(effectiveCount([10, 10, 10, 10])).toBeCloseTo(4);
    expect(evenShareCount([10, 10, 10, 10])).toBeCloseTo(4);
    const lop = [800, ...new Array(10).fill(20)];
    expect(effectiveCount(lop)).toBeLessThan(2);
    expect(evenShareCount(lop)).toBeLessThan(2);
  });
});

describe('bias against megacities and mega-districts', () => {
  it('spreads sizes out compared with plain counting and most-connected merging', () => {
    const { paths, pairs } = lopsided(24, 40, 30, 12, 7);
    const plain = sizes(cluster(unitTable(paths), unitEdges(paths.length, pairs), withBias(0), undefined, 'demo'));
    const biased = sizes(cluster(unitTable(paths), unitEdges(paths.length, pairs), withBias(1), undefined, 'demo'));
    expect(biased.cities[0]).toBeLessThan(plain.cities[0]);
    expect(biased.districts[0]).toBeLessThanOrEqual(plain.districts[0]);
    expect(effectiveCount(biased.cities)).toBeGreaterThan(effectiveCount(plain.cities));
    // nothing is lost or invented
    expect(biased.cities.reduce((a, b) => a + b, 0)).toBe(paths.length);
  });

  it('does not cap: one tightly bound block stays whole however large it is', () => {
    const rnd = mulberry32(3);
    const paths: string[] = [];
    for (let f = 0; f < 300; f++) paths.push(`engine/f${String(f).padStart(3, '0')}.ts`);
    for (let s = 0; s < 6; s++) for (let f = 0; f < 10; f++) paths.push(`tool${s}/f${f}.ts`);
    const pairs: [number, number][] = [];
    // every engine file leans on many others at random: no sub-structure to find
    for (let i = 0; i < 300; i++) for (let k = 0; k < 12; k++) { const j = Math.floor(rnd() * 300); if (j !== i) pairs.push([i, j]); }
    for (let s = 0; s < 6; s++) for (let f = 0; f < 10; f++) for (let k = 0; k < 3; k++) {
      const i = 300 + s * 10 + f, j = 300 + s * 10 + Math.floor(rnd() * 10);
      if (i !== j) pairs.push([i, j]);
    }
    const r = cluster(unitTable(paths), unitEdges(paths.length, pairs), withBias(1), undefined, 'demo');
    const cityOf = new Map(r.districts.map((d) => [d.id, d.city]));
    const engineCities = new Set(r.unitDistrict.slice(0, 300).map((d) => cityOf.get(d)));
    expect(engineCities.size).toBe(1);
  });

  it('divides a large directory that has no code in it', () => {
    const paths: string[] = [];
    for (let f = 0; f < 900; f++) paths.push(`data/records/r${String(f).padStart(4, '0')}.txt`);
    for (let s = 0; s < 8; s++) for (let f = 0; f < 15; f++) paths.push(`src/mod${s}/f${String(f).padStart(2, '0')}.ts`);
    const pairs: [number, number][] = [];
    for (let s = 0; s < 8; s++) for (let f = 1; f < 15; f++) pairs.push([900 + s * 15 + f, 900 + s * 15]);
    const r = cluster(unitTable(paths), unitEdges(paths.length, pairs), withBias(1), undefined, 'demo');
    const records = new Map<string, number>();
    for (let i = 0; i < 900; i++) records.set(r.unitDistrict[i], (records.get(r.unitDistrict[i]) ?? 0) + 1);
    expect(records.size).toBeGreaterThan(3);
    expect(Math.max(...records.values())).toBeLessThan(900 / 2);
    // neighbours in the listing stay together: far fewer district changes along the path order than files
    let changes = 0;
    for (let i = 1; i < 900; i++) if (r.unitDistrict[i] !== r.unitDistrict[i - 1]) changes++;
    expect(changes).toBeLessThan(records.size * 3);
  });
});

describe('belonging comes before balance', () => {
  it('a large flat directory may become several districts but stays in one city', () => {
    const paths: string[] = [];
    for (let f = 0; f < 900; f++) paths.push(`data/records/r${String(f).padStart(4, '0')}.txt`);
    for (let s2 = 0; s2 < 8; s2++) for (let f = 0; f < 15; f++) paths.push(`src/mod${s2}/f${String(f).padStart(2, '0')}.ts`);
    const pairs: [number, number][] = [];
    for (let s2 = 0; s2 < 8; s2++) for (let f = 1; f < 15; f++) pairs.push([900 + s2 * 15 + f, 900 + s2 * 15]);
    const r = cluster(unitTable(paths), unitEdges(paths.length, pairs), withBias(1), undefined, 'demo');
    const cityOf = new Map(r.districts.map((d) => [d.id, d.city]));
    const recordCities = new Set(r.unitDistrict.slice(0, 900).map((d) => cityOf.get(d)));
    expect(recordCities.size).toBe(1);
    expect(new Set(r.unitDistrict.slice(0, 900)).size).toBeGreaterThan(3);
  });

  it('a file goes to the community that holds most of its connections', () => {
    // nodes 0–3 in community 0, nodes 4–7 in community 1; node 3 is tied twice to community 1 and once to its own
    const labels = Int32Array.from([0, 0, 0, 0, 1, 1, 1, 1]);
    const pairs: [number, number][] = [[0, 1], [1, 2], [0, 2], [3, 0], [3, 4], [3, 5], [4, 5], [5, 6], [6, 7], [4, 7]];
    const edges = { count: pairs.length, a: Int32Array.from(pairs, (p) => p[0]), b: Int32Array.from(pairs, (p) => p[1]), w: new Float64Array(pairs.length).fill(1) };
    const settled = settleStragglers(labels, edges);
    expect(settled[3]).toBe(settled[4]);
    expect(settled[0]).toBe(settled[1]);
    expect(settled[0]).not.toBe(settled[4]);
  });
});

describe('what cluster() returns', () => {
  it('has no empty district and no empty city, whatever the shape of the repo', () => {
    // small random repos: a few top-level folders, sub-folders of uneven size, sparse random imports
    for (let seed = 1; seed <= 40; seed++) {
      const rnd = mulberry32(seed);
      const paths: string[] = [];
      const tops = 2 + Math.floor(rnd() * 4);
      for (let t = 0; t < tops; t++) {
        const subs = 1 + Math.floor(rnd() * 4);
        for (let s2 = 0; s2 < subs; s2++) {
          const files = 1 + Math.floor(rnd() * 14);
          for (let f = 0; f < files; f++) paths.push(`top${t}/sub${s2}/f${String(f).padStart(2, '0')}.ts`);
        }
      }
      paths.sort();
      const pairs: [number, number][] = [];
      for (let i = 0; i < paths.length; i++) if (rnd() < 0.7) pairs.push([i, Math.floor(rnd() * paths.length)]);
      const r = cluster(unitTable(paths), unitEdges(paths.length, pairs.filter(([a, b]) => a !== b)), config, undefined, 'demo');
      const used = new Set(r.unitDistrict);
      expect(new Set(r.districts.map((d) => d.id)), `seed ${seed}: districts`).toEqual(used);
      expect(new Set(r.cities.map((c) => c.id)), `seed ${seed}: cities`).toEqual(new Set(r.districts.map((d) => d.city)));
      expect(r.unitDistrict.every((d) => typeof d === 'string' && d !== ''), `seed ${seed}: every unit placed`).toBe(true);
    }
  });
});
