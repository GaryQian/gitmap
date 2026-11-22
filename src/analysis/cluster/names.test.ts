import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../shared';
import { Namer } from './names';

/** Names for sibling groups given as lists of paths. */
function nameGroups(groups: string[][], previous?: (string | undefined)[], fallback = 'repo'): string[] {
  const namer = new Namer(groups.flat());
  let at = 0;
  return namer.name(groups.map((g) => g.map(() => at++)), fallback, previous);
}

const files = (dir: string, names: string[]): string[] => names.map((n) => `${dir}/${n}`);
const numbered = (dir: string, n: number, stem = 'f'): string[] => Array.from({ length: n }, (_, i) => `${dir}/${stem}${i}.ts`);
const endsInNumber = /\s\d+$/;

describe('Namer', () => {
  it('names sibling districts by what differs under their shared directory', () => {
    // Everything sits under app/server: no district is named after "app".
    const names = nameGroups([numbered('app/server/http', 6), numbered('app/server/ws', 6), numbered('app/server', 6)]);
    expect(names).toEqual(['http', 'ws', 'server']);

    // Two groups in the same directory: the weaker claim goes deeper along the path.
    const shared = nameGroups([
      [...numbered('pkg/core/render', 8), ...numbered('pkg/core/render/gl', 2)],
      [...numbered('pkg/core/render', 2, 'g'), ...numbered('pkg/core/render/svg', 6)],
      numbered('pkg/core/io', 5),
    ]);
    expect(shared).toEqual(['render', 'svg', 'io']);
    // A segment that says nothing gives way to the directory above it.
    expect(nameGroups([numbered('packages/react-dom/src', 5), numbered('packages/scheduler/src', 5)])).toEqual(['react-dom', 'scheduler']);
  });

  it('names runs cut from one flat directory by their range of file names', () => {
    const letters = 'ABCDEFGHIJKLMNOPQRST'.split('');
    const all = files('core/ops', letters.flatMap((l) => [`api_def_${l}a.pbtxt`, `api_def_${l}b.pbtxt`]));
    const runs = [all.slice(0, 10), all.slice(10, 20), all.slice(20, 30), all.slice(30)];
    expect(nameGroups(runs)).toEqual(['ops A–E', 'ops F–J', 'ops K–O', 'ops P–T']);

    // Boundaries inside long shared stems still give short, distinct ranges, and no bare numbers.
    const fixtures = files('tests/fixtures', [
      'error.invalid-mutate-props.js', 'error.invalid-reassign-const.js', 'error.invalid-ref-in-render.js', 'error.invalid-setstate.js',
      'error.modify-state.js', 'error.ref-initialization.js', 'hoisting-let.js', 'hoisting-var.js', 'hook-call.js', 'infer-types.js',
      'jsx-spread.js', 'jsx-tag.js',
    ]);
    const cut = nameGroups([fixtures.slice(0, 4), fixtures.slice(4, 8), fixtures.slice(8)]);
    expect(new Set(cut).size).toBe(3);
    for (const name of cut) {
      expect(name).toMatch(/–/);
      expect(name).not.toMatch(endsInNumber);
      expect(name.length).toBeLessThanOrEqual(30);
    }
  });

  it('tells two cities with the same best segment apart without a number', () => {
    const big = [...numbered('packages/react', 6), ...numbered('packages/scheduler', 5), ...numbered('packages/shared', 5)];
    // A third of the grab-bag is react-dom: that is its name.
    const third = [...numbered('packages/react-dom', 3), ...numbered('packages/react-art', 2), ...numbered('packages/react-is', 2), ...numbered('packages/shared', 2, 'g')];
    expect(nameGroups([big, third, numbered('scripts', 4)])).toEqual(['packages', 'react-dom', 'scripts']);
    // A smaller share is named beside the shared segment.
    const quarter = [...third, ...numbered('packages/react-noop', 2), 'packages/shared/h.ts'];
    expect(nameGroups([big, quarter, numbered('scripts', 4)])).toEqual(['packages', 'packages/react-dom', 'scripts']);
  });

  it('keeps a previous name while it is free', () => {
    const groups = [numbered('app/http', 5), numbered('app/ws', 5), numbered('app/db', 5)];
    expect(nameGroups(groups, ['transport', undefined, undefined])).toEqual(['transport', 'ws', 'db']);
    // A previous name that is another group's natural name stays with the group that had it.
    expect(nameGroups(groups, ['ws', undefined, undefined])[0]).toBe('ws');
    // Two groups cannot both keep the same name.
    const clash = nameGroups(groups, ['same', 'same', undefined]);
    expect(clash.filter((n) => n === 'same')).toHaveLength(1);
    expect(new Set(clash).size).toBe(3);
  });

  it('never returns an empty or repeated name, in any input order', () => {
    const flat = files('data/golden', Array.from({ length: 30 }, (_, i) => `case-${String.fromCharCode(97 + (i % 26))}${i}.txt`)).sort();
    const groups = [
      ['README.md', 'LICENSE'], ['package.json'],
      flat.slice(0, 10), flat.slice(10, 20), flat.slice(20),
      numbered('src/server', 4), numbered('src/server', 4, 'g'), numbered('src/server', 4, 'h'),
      numbered('a/util', 3), numbered('b/util', 3), numbered('lib', 3), numbered('src', 2),
    ];
    const names = nameGroups(groups, undefined, '');
    for (const name of names) expect(name.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(groups.length);
    const byFirst = new Map(groups.map((g, k) => [g[0], names[k]]));

    // Shuffle the groups, the members of each and the paths the namer is built from.
    const rnd = mulberry32(7);
    const shuffle = <T>(xs: T[]): T[] => {
      const out = xs.slice();
      for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
      return out;
    };
    const mixed = shuffle(groups).map(shuffle);
    const paths = shuffle(mixed.flat());
    const index = new Map(paths.map((p, i) => [p, i]));
    const again = new Namer(paths).name(mixed.map((g) => g.map((p) => index.get(p)!)), '');
    mixed.forEach((g, k) => { expect(again[k]).toBe(byFirst.get(groups.find((x) => x.includes(g[0]))![0])); });
  });
});
