// An Update must move only what changed (PLAN.md §6.8): with `previous.incremental`, every unit that
// had a district keeps it and only new units are placed.
import { describe, expect, it } from 'vitest';
import { config } from '../../config';
import type { AnalysisInput } from '../../contracts/pipeline';
import type { UnitEdges } from '../edges';
import type { UnitTable } from '../units';
import { clusterIncremental } from './incremental';
import { cluster } from './index';

function unitTable(paths: string[]): UnitTable {
  return {
    count: paths.length, ids: paths, primaryFile: paths,
    fileCount: paths.map(() => 1), loc: paths.map(() => 10), bytes: paths.map(() => 100), lang: paths.map(() => 'ts'),
    fileUnit: Int32Array.from(paths, (_, i) => i), unitOfFile: new Map(paths.map((p, i) => [p, i])),
  };
}

function unitEdges(paths: string[], pairs: [string, string][]): UnitEdges {
  const index = new Map(paths.map((p, i) => [p, i]));
  const kept = pairs.filter(([s, d]) => index.has(s) && index.has(d));
  return {
    count: kept.length,
    src: Int32Array.from(kept, (p) => index.get(p[0])!), dst: Int32Array.from(kept, (p) => index.get(p[1])!),
    kind: kept.map(() => 'import'), weight: new Float64Array(kept.length).fill(1), confidence: new Float64Array(kept.length).fill(1),
    mechanism: kept.map(() => ''), symbols: kept.map(() => ''), fanIn: new Int32Array(paths.length), fanOut: new Int32Array(paths.length),
  };
}

/** Six packages of thirty files, each file importing a few files of its own package. */
function repo() {
  const paths: string[] = [];
  const pairs: [string, string][] = [];
  for (let p = 0; p < 6; p++) for (let f = 0; f < 30; f++) paths.push(`pkg${p}/f${String(f).padStart(2, '0')}.ts`);
  for (let p = 0; p < 6; p++) for (let f = 1; f < 30; f++) {
    pairs.push([`pkg${p}/f${String(f).padStart(2, '0')}.ts`, `pkg${p}/f${String((f * 7) % 30).padStart(2, '0')}.ts`]);
    pairs.push([`pkg${p}/f${String(f).padStart(2, '0')}.ts`, `pkg${p}/f00.ts`]);
  }
  return { paths: paths.sort(), pairs };
}

function previousOf(paths: string[], r: ReturnType<typeof cluster>): NonNullable<AnalysisInput['previous']> & { incremental: boolean } {
  const previous = { unitDistrict: {} as Record<string, string>, districtCity: {} as Record<string, string>, districtName: {} as Record<string, string>, cityName: {} as Record<string, string>, incremental: true };
  paths.forEach((p, i) => { previous.unitDistrict[p] = r.unitDistrict[i]; });
  for (const d of r.districts) { previous.districtCity[d.id] = d.city; previous.districtName[d.id] = d.name; }
  for (const c of r.cities) previous.cityName[c.id] = c.name;
  return previous;
}

describe('incremental clustering (Update)', () => {
  it('keeps every unit where it was and places only the new ones', () => {
    const { paths, pairs } = repo();
    const first = cluster(unitTable(paths), unitEdges(paths, pairs), config, undefined, 'demo');
    const previous = previousOf(paths, first);

    // one file removed, one added that imports pkg3, one added with no edges beside pkg5's files
    const next = paths.filter((p) => p !== 'pkg1/f07.ts').concat(['pkg0/new-user.ts', 'pkg5/notes.md']).sort();
    const nextPairs: [string, string][] = [...pairs, ['pkg0/new-user.ts', 'pkg3/f00.ts'], ['pkg0/new-user.ts', 'pkg3/f05.ts']];
    const second = cluster(unitTable(next), unitEdges(next, nextPairs), config, previous, 'demo');

    const districtOf = new Map(next.map((p, i) => [p, second.unitDistrict[i]]));
    for (const p of next) if (previous.unitDistrict[p] !== undefined) expect(districtOf.get(p), p).toBe(previous.unitDistrict[p]);
    // by connection: where the files it imports live, not where its folder says
    expect(districtOf.get('pkg0/new-user.ts')).toBe(previous.unitDistrict['pkg3/f00.ts']);
    // by directory: with the files beside it
    expect(districtOf.get('pkg5/notes.md')).toBe(previous.unitDistrict['pkg5/f00.ts']);
    // ids, cities and names are the previous ones
    for (const d of second.districts) {
      expect(previous.districtCity[d.id]).toBe(d.city);
      expect(d.name).toBe(previous.districtName[d.id]);
    }
    expect(second.cities.map((c) => c.id).sort()).toEqual(first.cities.map((c) => c.id).sort());
  });

  it('declines when too much of the map is new, and a full clustering runs instead', () => {
    const { paths, pairs } = repo();
    const half = paths.filter((p) => p < 'pkg3');
    const first = cluster(unitTable(half), unitEdges(half, pairs), config, undefined, 'demo');
    const previous = previousOf(half, first);
    expect(clusterIncremental(unitTable(paths), unitEdges(paths, pairs), config, previous)).toBeNull();
    const second = cluster(unitTable(paths), unitEdges(paths, pairs), config, previous, 'demo');
    expect(second.unitDistrict.every((d) => typeof d === 'string' && d !== '')).toBe(true);
    expect(new Set(second.unitDistrict).size).toBeGreaterThan(new Set(first.unitDistrict).size);
  });

  it('without the flag a re-run still clusters from scratch', () => {
    const { paths, pairs } = repo();
    const first = cluster(unitTable(paths), unitEdges(paths, pairs), config, undefined, 'demo');
    const { incremental: _unused, ...plain } = previousOf(paths, first);
    const again = cluster(unitTable(paths), unitEdges(paths, pairs), config, plain, 'demo');
    expect(again.unitDistrict).toEqual(first.unitDistrict);
  });
});
