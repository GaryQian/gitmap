// clustering.mergePathBias: when a community is merged away, a neighbour from the same directory
// tree is preferred over one about as well connected from elsewhere. A lean, not a rule.
import { describe, expect, it } from 'vitest';
import type { EdgeList } from './graph';
import { dirCloseness, mergeDown } from './merge';

describe('dirCloseness', () => {
  it('is 1 for the same directory and falls with distance in the tree', () => {
    expect(dirCloseness('a/b/', 'a/b/')).toBe(1);
    expect(dirCloseness('a/x/', 'a/y/')).toBe(1 / 2);
    expect(dirCloseness('a/', 'a/x/')).toBe(1 / 2);
    expect(dirCloseness('a/b/c/', 'a/z/')).toBe(1 / 3);
    expect(dirCloseness('a/x/', 'b/x/')).toBe(0);
  });

  it('is 0 for a community with no directory of its own', () => {
    expect(dirCloseness('', 'a/b/')).toBe(0);
    expect(dirCloseness('', '')).toBe(0);
  });
});

describe('merging with a path bias', () => {
  // S: two files in alpha/x. A: four files in alpha/y. B: four files in beta/z.
  const paths = [
    'alpha/x/s0.ts', 'alpha/x/s1.ts',
    'alpha/y/a0.ts', 'alpha/y/a1.ts', 'alpha/y/a2.ts', 'alpha/y/a3.ts',
    'beta/z/b0.ts', 'beta/z/b1.ts', 'beta/z/b2.ts', 'beta/z/b3.ts',
  ];
  const labels = Int32Array.from([0, 0, 1, 1, 1, 1, 2, 2, 2, 2]);
  const size = paths.map(() => 1);
  const pathOf = (node: number) => paths[node];
  const S = 0, A = 2, B = 6;

  /** Which community S ends up in when it is tied to A with weight `toA` and to B with `toB`. */
  function joins(pathBias: number, toA: number, toB: number): 'A' | 'B' {
    const edges: EdgeList = { count: 2, a: Int32Array.from([S, S]), b: Int32Array.from([A, B]), w: Float64Array.from([toA, toB]) };
    const out = mergeDown(labels, edges, size, 2, 1, pathOf, 0, Infinity, false, pathBias).labels;
    expect(out[A]).not.toBe(out[B]);
    return out[S] === out[A] ? 'A' : 'B';
  }

  it('without bias, the better-connected neighbour wins whatever its directory', () => {
    expect(joins(0, 2.5, 3)).toBe('B');
  });

  it('with bias, the neighbour from the same tree wins when the other is only slightly better connected', () => {
    // closeness(alpha/x, alpha/y) = 1/2, so A scores 2.5 × 1.5 = 3.75 against B's 3
    expect(joins(1, 2.5, 3)).toBe('A');
  });

  it('is not strict: a much better connection across trees still wins', () => {
    expect(joins(1, 2.5, 9)).toBe('B');
  });

  it('changes nothing between neighbours equally close in the tree', () => {
    // both partners in alpha: the plain rule decides
    const local = ['alpha/x/s0.ts', 'alpha/x/s1.ts', 'alpha/y/a0.ts', 'alpha/y/a1.ts', 'alpha/y/a2.ts', 'alpha/z/b0.ts', 'alpha/z/b1.ts', 'alpha/z/b2.ts'];
    const l = Int32Array.from([0, 0, 1, 1, 1, 2, 2, 2]);
    const edges: EdgeList = { count: 2, a: Int32Array.from([0, 0]), b: Int32Array.from([2, 5]), w: Float64Array.from([2, 3]) };
    const out = mergeDown(l, edges, local.map(() => 1), 2, 1, (n) => local[n], 0, Infinity, false, 4).labels;
    expect(out[0]).toBe(out[5]);
  });
});
