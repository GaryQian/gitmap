import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../shared';
import { createSearchIndex, matchPath, matchRanges, toSearchHits } from './index';

const PATHS = [
  'README.md',
  'package.json',
  'src/app/store.ts',
  'src/app/store.test.ts',
  'src/app/selectionState.ts',
  'src/app/session.ts',
  'src/app/ui/Pill.tsx',
  'src/app/ui/index.ts',
  'src/pipeline/session.ts',
  'src/pipeline/restore.ts',
  'src/store/index.ts',
  'src/store/modelStore.ts',
  'src/render/edges/index.ts',
  'test/store/helpers.ts',
  'docs/Store.md',
  'a/very/deep/folder/store.ts',
];

const search = (query: string, limit?: number) => createSearchIndex(PATHS).search(query, limit).map((r) => r.path);

describe('ranking', () => {
  it('puts the file name before the directories, and the closest name first', () => {
    const got = search('store');
    // exact stem (shortest path first), then names starting with it, then names containing it, then directories
    expect(got.slice(0, 3)).toEqual(['docs/Store.md', 'src/app/store.ts', 'a/very/deep/folder/store.ts']);
    expect(got[3]).toBe('src/app/store.test.ts');
    expect(got.indexOf('src/store/modelStore.ts')).toBeLessThan(got.indexOf('src/pipeline/restore.ts'));
    expect(got.indexOf('src/pipeline/restore.ts')).toBeLessThan(got.indexOf('src/store/index.ts'));
    expect(got).toContain('test/store/helpers.ts');
    expect(search('store.ts')[0]).toBe('src/app/store.ts');
  });

  it('breaks ties by shorter path, then by path', () => {
    expect(search('session')).toEqual(['src/app/session.ts', 'src/pipeline/session.ts']);
    expect(search('index.ts')).toEqual(['src/store/index.ts', 'src/app/ui/index.ts', 'src/render/edges/index.ts']);
  });

  it('matches several terms in any order', () => {
    expect(search('store test')[0]).toBe('src/app/store.test.ts');
    expect(search('test store')[0]).toBe('src/app/store.test.ts');
    expect(search('test store')).toContain('test/store/helpers.ts');
    expect(search('pill ui')).toEqual(['src/app/ui/Pill.tsx']);
  });

  it('ignores case until the query has a capital', () => {
    expect(search('pill')).toEqual(['src/app/ui/Pill.tsx']);
    expect(search('Store')).toEqual(['docs/Store.md', 'src/store/modelStore.ts']);
    expect(search('state')).toEqual(['src/app/selectionState.ts']);
  });

  it('matches a query with a slash against the whole path', () => {
    expect(search('app/store')).toEqual(['src/app/store.ts', 'src/app/store.test.ts']);
    expect(search('store/')).toEqual(['src/store/index.ts', 'test/store/helpers.ts', 'src/store/modelStore.ts']);
    expect(search('/src/app/ui')).toEqual(['src/app/ui/Pill.tsx', 'src/app/ui/index.ts']);
  });

  it('keeps short queries to names that start with them, then whole directory names', () => {
    expect(search('se')).toEqual(['src/app/session.ts', 'src/pipeline/session.ts', 'src/app/selectionState.ts']);
    expect(search('ui')).toEqual(['src/app/ui/Pill.tsx', 'src/app/ui/index.ts']);
  });

  it('tolerates a typo only when nothing matches exactly', () => {
    expect(search('sesion')).toEqual(['src/app/session.ts', 'src/pipeline/session.ts']);
    expect(search('selectoinState')[0]).toBe('src/app/selectionState.ts');
    expect(search('zzzz')).toEqual([]);
    expect(search('   ')).toEqual([]);
  });

  it('reports ranges that spell the match, and scores that agree with matching the path alone', () => {
    const index = createSearchIndex(PATHS);
    for (const query of ['store', 'store test', 'app/store', 'Pill', 'se', 'sesion', 'ts']) {
      const results = index.search(query, 50);
      expect(results.length).toBeGreaterThan(0);
      for (let k = 1; k < results.length; k++) expect(results[k]!.score).toBeLessThanOrEqual(results[k - 1]!.score);
      for (const r of results) {
        expect(r.ranges.length % 2).toBe(0);
        for (let k = 0; k < r.ranges.length; k += 2) {
          expect(r.ranges[k]!).toBeLessThan(r.ranges[k + 1]!);
          expect(r.ranges[k + 1]!).toBeLessThanOrEqual(r.path.length);
        }
        expect(matchPath(r.path, query)).toEqual(r);
      }
    }
    const [from, to] = matchRanges('src/app/store.test.ts', 'test');
    expect('src/app/store.test.ts'.slice(from, to)).toBe('test');
    expect(matchRanges('src/app/store.ts', 'app/store')).toEqual([4, 13]);
    expect(matchRanges('src/app/store.ts', 'nothing')).toEqual([]);
  });
});

describe('index upkeep', () => {
  it('stays consistent through add, remove and setPaths', () => {
    const index = createSearchIndex(['src/a.ts']);
    expect(index.size).toBe(1);
    index.add(['src/store.ts', 'lib/store.ts', 'src/a.ts']);
    expect(index.size).toBe(3);
    expect(index.search('store').map((r) => r.path)).toEqual(['lib/store.ts', 'src/store.ts']);
    index.remove(['lib/store.ts', 'not/there.ts']);
    expect(index.size).toBe(2);
    expect(index.search('store').map((r) => r.path)).toEqual(['src/store.ts']);
    index.setPaths(['x/y.ts']);
    expect(index.search('store')).toEqual([]);
    expect(index.search('y').map((r) => r.path)).toEqual(['x/y.ts']);
    index.setPaths([]);
    expect(index.search('y')).toEqual([]);
  });

  it('maps results to hits through the caller\'s path lookup', () => {
    const results = createSearchIndex(['src/a.h', 'src/a.cpp', 'src/gone.cpp']).search('a');
    const hits = toSearchHits(results, (path) => (path.includes('gone') ? null : 'u:src/a.cpp'));
    expect(hits.map((h) => [h.ref, h.path])).toEqual([['u:src/a.cpp', 'src/a.h'], ['u:src/a.cpp', 'src/a.cpp']]);
  });
});

/** Paths shaped like a real tree: a few top folders, nested feature folders, compound file names. */
function syntheticPaths(count: number): string[] {
  const rnd = mulberry32(7);
  const pick = <V>(list: readonly V[]): V => list[Math.floor(rnd() * list.length)]!;
  const tops = ['src', 'lib', 'packages', 'apps', 'test', 'tools', 'docs', 'internal'];
  const dirs = ['app', 'core', 'ui', 'render', 'pipeline', 'store', 'model', 'utils', 'components', 'hooks', 'api', 'auth', 'search', 'config', 'shared', 'physics', 'layout', 'worker', 'net', 'db'];
  const words = ['store', 'session', 'index', 'state', 'view', 'model', 'edge', 'node', 'graph', 'buffer', 'cache', 'query', 'parse', 'layout', 'theme', 'button', 'list', 'item', 'user', 'event', 'queue', 'worker', 'reader', 'writer', 'tree', 'path', 'config', 'select', 'search', 'render'];
  const exts = ['ts', 'tsx', 'test.ts', 'js', 'py', 'go', 'rs', 'cpp', 'h', 'md', 'json', 'css'];
  const cap = (w: string): string => w[0]!.toUpperCase() + w.slice(1);
  const out = new Set<string>();
  while (out.size < count) {
    const depth = 1 + Math.floor(rnd() * 5);
    const parts = [pick(tops)];
    for (let d = 0; d < depth; d++) parts.push(rnd() < 0.2 ? `${pick(dirs)}-${pick(words)}` : pick(dirs));
    const style = rnd();
    const a = pick(words);
    const b = pick(words);
    const name = style < 0.3 ? a : style < 0.6 ? a + cap(b) : style < 0.8 ? `${a}_${b}` : `${cap(a)}${cap(b)}${Math.floor(rnd() * 100)}`;
    parts.push(`${name}${rnd() < 0.5 ? Math.floor(rnd() * 1000) : ''}.${pick(exts)}`);
    out.add(parts.join('/'));
  }
  return [...out];
}

describe('at 100k paths', () => {
  it('answers quickly (logged, not asserted)', () => {
    const paths = syntheticPaths(100_000);
    const index = createSearchIndex();
    let t0 = performance.now();
    index.setPaths(paths);
    index.warm();
    const buildMs = performance.now() - t0;

    const queries = ['s', 'st', 'sto', 'store', 'storeSession', 'session.ts', 'src', 'components', 'store test', 'ui button', 'app/store', 'src/', 'tsx', 'StoreView', 'sesion', 'qeury cache', 'zzzzzz'];
    const lines: string[] = [];
    for (const query of queries) {
      index.search(query, 20); // warm the JIT
      // the median of several runs: the machine is usually busy with other work while tests run
      const times: number[] = [];
      let found = 0;
      for (let r = 0; r < 9; r++) {
        t0 = performance.now();
        found = index.search(query, 20).length;
        times.push(performance.now() - t0);
      }
      times.sort((a, b) => a - b);
      lines.push(`${JSON.stringify(query).padEnd(16)} ${times[4]!.toFixed(2).padStart(7)} ms (best ${times[0]!.toFixed(2)})  ${found} results`);
    }
    console.log(`search over ${index.size.toLocaleString('en')} paths (index built in ${buildMs.toFixed(0)} ms); median of 9\n${lines.join('\n')}`);
    expect(index.search('store', 20)).toHaveLength(20);
  });
});
