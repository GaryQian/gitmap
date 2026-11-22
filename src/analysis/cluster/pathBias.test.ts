// clustering.pathBias: code edges between files close in the directory tree count for more, so
// communities lean toward directory trees without being bound to them.
import { describe, expect, it } from 'vitest';
import { config } from '../../config';
import type { UnitEdges } from '../edges';
import type { UnitTable } from '../units';
import { buildClusterGraph, pathProximity } from './graph';
import { louvainLevels } from './louvain';

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

/** Only the bias under test: no hub damping and no directory ties. */
const only = (pathBias: number) => ({ ...config.clustering, hubDamping: false, directoryAffinity: 0, pathBias });

describe('pathProximity', () => {
  it('is 1 inside one directory, and at the repo root', () => {
    expect(pathProximity('src/a.ts', 'src/b.ts')).toBe(1);
    expect(pathProximity('a/b/c/x.ts', 'a/b/c/y.ts')).toBe(1);
    expect(pathProximity('x.ts', 'y.ts')).toBe(1);
  });

  it('falls with distance in the tree, measured against the deeper file', () => {
    expect(pathProximity('a/x/f.ts', 'a/y/g.ts')).toBe(1 / 2);
    expect(pathProximity('a/f.ts', 'a/x/g.ts')).toBe(1 / 2);
    expect(pathProximity('a/b/c/f.ts', 'a/b/d/g.ts')).toBe(2 / 3);
    expect(pathProximity('a/b/c/f.ts', 'a/z/g.ts')).toBe(1 / 3);
  });

  it('is 0 when nothing is shared, and is not fooled by a shared name prefix', () => {
    expect(pathProximity('src/a.ts', 'test/a.ts')).toBe(0);
    expect(pathProximity('x.ts', 'src/y.ts')).toBe(0);
    expect(pathProximity('src/app/a.ts', 'src/apple/b.ts')).toBe(1 / 2); // 'src' is shared, 'app' ≠ 'apple'
  });

  it('is symmetric', () => {
    expect(pathProximity('a/b/c/f.ts', 'a/z/g.ts')).toBe(pathProximity('a/z/g.ts', 'a/b/c/f.ts'));
  });
});

describe('path bias in the clustering graph', () => {
  const paths = ['a/x/f1.ts', 'a/x/f2.ts', 'a/y/g.ts', 'b/h.ts'];
  const edges = unitEdges(4, [[0, 1], [0, 2], [0, 3]]);
  const weightOf = (g: ReturnType<typeof buildClusterGraph>, x: number, y: number) => {
    for (let e = 0; e < g.count; e++) if (g.a[e] === x && g.b[e] === y) return g.w[e];
    return undefined;
  };

  it('leaves weights alone at 0', () => {
    const g = buildClusterGraph(unitTable(paths), edges, only(0));
    expect([weightOf(g, 0, 1), weightOf(g, 0, 2), weightOf(g, 0, 3)]).toEqual([1, 1, 1]);
  });

  it('multiplies a code edge by 1 + bias × proximity', () => {
    const g = buildClusterGraph(unitTable(paths), edges, only(2));
    expect(weightOf(g, 0, 1)).toBeCloseTo(3);  // same directory
    expect(weightOf(g, 0, 2)).toBeCloseTo(2);  // sibling directories
    expect(weightOf(g, 0, 3)).toBeCloseTo(1);  // another tree: unchanged, never reduced
  });
});

describe('path bias in the communities found', () => {
  // Two tight groups of ten, one per directory tree, and a file `p` that lives in the first tree.
  const ring = (dir: string) => Array.from({ length: 10 }, (_, i) => `${dir}/m${i}.ts`);
  const paths = [...ring('alpha/core'), 'alpha/core/p.ts', ...ring('beta/core')];
  const P = 10, ALPHA = 0, BETA = 11;
  const inside: [number, number][] = [];
  for (const base of [ALPHA, BETA]) for (let i = 0; i < 10; i++) for (const step of [1, 2, 3]) inside.push([base + i, base + ((i + step) % 10)]);

  /** Which group `p` ends up with, when it has `own` edges into its own tree and `other` into the other. */
  function home(pathBias: number, own: number, other: number): 'alpha' | 'beta' | 'neither' {
    const pairs = [...inside];
    for (let i = 0; i < own; i++) pairs.push([P, ALPHA + i]);
    for (let i = 0; i < other; i++) pairs.push([P, BETA + i]);
    const g = buildClusterGraph(unitTable(paths), unitEdges(paths.length, pairs), only(pathBias));
    const levels = louvainLevels(g.nodes, g, 1, 1);
    const top = levels[levels.length - 1];
    return top[P] === top[ALPHA] ? 'alpha' : top[P] === top[BETA] ? 'beta' : 'neither';
  }

  it('without bias, a file follows whichever tree it has more edges into', () => {
    expect(home(0, 2, 3)).toBe('beta');
  });

  it('with bias, a file stays with its own tree when the other pulls only slightly harder', () => {
    expect(home(1, 2, 3)).toBe('alpha');
  });

  it('is not strict: enough coupling across trees still wins', () => {
    expect(home(1, 2, 9)).toBe('beta');
  });
});
