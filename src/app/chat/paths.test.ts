import { describe, expect, it } from 'vitest';
import { createReplica } from '../../model';
import { syntheticBatch } from '../../testing/synthetic';
import { linkTarget, resolveMention } from './paths';

function replica() {
  const r = createReplica();
  r.apply(syntheticBatch({ files: 40, cities: 2, districtsPerCity: 2, seed: 5 }));
  return r;
}

describe('file paths in an answer', () => {
  const r = replica();
  const units = r.table('unit');
  const path = units.ids[units.slots()[7]!]!; // "city-0/district-0-1/file7.ts"
  const [city, district, name] = path.split('/') as [string, string, string];

  it('finds a path as the map spells it, with the decorations a model adds', () => {
    expect(resolveMention(r, path)).toBe(path);
    expect(resolveMention(r, ` ./${path} `)).toBe(path);
    expect(resolveMention(r, `${path}:42`)).toBe(path);
    expect(resolveMention(r, `${path}:10-20`)).toBe(path);
    expect(resolveMention(r, path.replace(/\//g, '\\'))).toBe(path);
  });

  it('finds the end of a path when only one file ends that way', () => {
    expect(resolveMention(r, name)).toBe(path);
    expect(resolveMention(r, `${district}/${name}`)).toBe(path);
    expect(resolveMention(r, `other/${name}`)).toBeNull();
  });

  it('leaves alone what is not a file here', () => {
    expect(resolveMention(r, 'README.md')).toBeNull();
    expect(resolveMention(r, name.replace(/\.\w+$/, ''))).toBeNull(); // a bare word
    expect(resolveMention(r, `open ${path}`)).toBeNull(); // prose
    expect(resolveMention(r, `${city}/${district}/`)).toBeNull(); // a folder
    expect(resolveMention(r, 'const x = 1;')).toBeNull();
    expect(resolveMention(r, '')).toBeNull();
  });

  it('reads a relative link target as a path and a web link as none', () => {
    expect(linkTarget('src/a%20b.ts#L10')).toBe('src/a b.ts');
    expect(linkTarget('https://example.com/a.ts')).toBe('');
    expect(linkTarget('mailto:x@example.com')).toBe('');
  });
});
