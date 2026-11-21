import { describe, expect, it } from 'vitest';
import { config } from '../config';
import type { FileFacts, LanguagePlugin } from '../contracts/lang';
import type { AnalysisInput } from '../contracts/pipeline';
import { createReplica, edgeId } from '../model';
import { mulberry32 } from '../shared';
import { tablesToFullBatch, tablesToOps } from '../testing/synthetic';
import { aggregateEdges } from './edges';
import { analyze } from './index';
import { sortFiles } from './order';
import { buildUnits } from './units';

// A fake language: an import's spec is the target path, optionally 'path@confidence'; several
// targets are separated by ','. It answers with paths as written, present in the repo or not.
const fake: LanguagePlugin = {
  id: 'fake', name: 'Fake', extensions: ['fk'], color: '#888888',
  scan: () => ({ imports: [] }),
  createResolver: () => ({
    resolve: (_file, imp) => imp.spec.split(',').map((part) => {
      const [path, conf] = part.split('@');
      return { path, confidence: conf === undefined ? 1 : Number(conf) };
    }),
  }),
};
const options = { plugins: [fake] };

function file(path: string, imports: string[] = [], loc = 10): FileFacts {
  return {
    path, oid: `oid-${path}`, bytes: loc * 30, loc,
    lang: path.endsWith('.fk') ? 'fake' : null,
    imports: imports.map((spec) => ({ spec, kind: 'import' })),
  };
}
const run = (files: FileFacts[], extra: Partial<AnalysisInput> = {}) =>
  analyze({ repoName: 'demo', files, ...extra }, config, options);

/** A repo of `n` files over a few folders, each importing a few earlier or later files. */
function randomRepo(n: number, seed: number): FileFacts[] {
  const rnd = mulberry32(seed);
  const tops = ['web', 'server', 'tools'];
  const subs = ['src', 'lib', 'misc'];
  const paths = Array.from({ length: n }, (_, i) => {
    const r = rnd();
    if (r < 0.05) return `root${i}.fk`;
    const top = tops[Math.floor(rnd() * tops.length)];
    return r < 0.2 ? `${top}/f${i}.fk` : `${top}/${subs[Math.floor(rnd() * subs.length)]}/f${i}.fk`;
  });
  return paths.map((p) => {
    const imports: string[] = [];
    const k = Math.floor(rnd() * 5);
    for (let j = 0; j < k; j++) imports.push(paths[Math.floor(rnd() * rnd() * n)] + (rnd() < 0.2 ? '@0.5' : ''));
    return file(p, imports, 1 + Math.floor(rnd() * 400));
  });
}

describe('analyze', () => {
  it('resolves imports and aggregates them to one edge per unit pair', () => {
    const result = run([
      file('app/main.fk', ['lib/util.fk', 'lib/util.fk@0.4', 'lib/core.fk@0.5', 'gone/missing.fk', 'app/main.fk']),
      file('lib/util.fk', ['lib/core.fk,lib/core.fk@0.2']),
      file('lib/core.fk'),
      file('README.md', ['lib/core.fk']), // no plug-in claims it: its imports cannot resolve
    ]);
    const { edge, unit, file: files } = result.tables;
    const row = (src: string, dst: string) => {
      const i = edge.ids.indexOf(edgeId(src, dst));
      expect(i, `${src} → ${dst}`).toBeGreaterThanOrEqual(0);
      return { kind: edge.cols.kind![i], weight: edge.cols.weight![i], confidence: edge.cols.confidence![i] };
    };
    expect(edge.ids).toHaveLength(3);
    expect(row('app/main.fk', 'lib/util.fk')).toEqual({ kind: 'import', weight: 2, confidence: 1 });
    expect(row('app/main.fk', 'lib/core.fk')).toEqual({ kind: 'import', weight: 1, confidence: 0.5 });
    expect(row('lib/util.fk', 'lib/core.fk')).toEqual({ kind: 'import', weight: 1, confidence: 1 });
    expect(edge.cols.mechanism).toEqual(['', '', '']);
    expect(edge.cols.symbols).toEqual(['', '', '']);

    const u = (id: string) => unit.ids.indexOf(id);
    expect(unit.cols.fanIn![u('lib/core.fk')]).toBe(2);
    expect(unit.cols.fanOut![u('app/main.fk')]).toBe(2);
    expect(unit.cols.fanIn![u('app/main.fk')]).toBe(0);
    expect(unit.cols.importancePct![u('lib/core.fk')]).toBe(1);
    expect(unit.cols.importancePct![u('app/main.fk')]).toBe(0);
    expect(unit.cols.lang![u('README.md')]).toBe('other');
    expect(files.cols.unit).toEqual(files.ids);
    expect(files.cols.oid![files.ids.indexOf('lib/core.fk')]).toBe('oid-lib/core.fk');

    expect(result.diagnostics.importsTotal).toBe(7);
    expect(result.diagnostics.importsResolved).toBe(4);
    expect(result.stats).toEqual({ files: 4, units: 4, edges: 3, loc: 40 });
    expect(result.structure).toBe('imports-only');
    expect(run([file('a.fk')], { syntax: [], syntaxComplete: true }).structure).toBe('full');
    expect(run([file('a.fk')], { syntax: [] }).structure).toBe('imports-only');
  });

  it('is deterministic and independent of input file order', () => {
    const files = randomRepo(400, 7);
    const a = run(files);
    const rnd = mulberry32(99);
    const shuffled = [...files];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const b = run(shuffled);
    expect(a.tables.edge.ids.length).toBeGreaterThan(200);
    expect(b.tables).toEqual(a.tables);
    expect(b.stats).toEqual(a.stats);
    expect(run(files).tables).toEqual(a.tables);
  });

  it('produces tables a replica accepts, with every reference resolving', () => {
    const result = run(randomRepo(300, 3));
    const { tables, stats } = result;
    expect(tablesToOps(tables).map((op) => (op.op === 'add' ? op.kind : op.op))).toEqual(['city', 'district', 'unit', 'file', 'edge']);
    const replica = createReplica();
    expect(replica.apply(tablesToFullBatch(tables))).toBe(true);
    expect(replica.table('file').count).toBe(300);
    expect(replica.table('unit').count).toBe(stats.units);
    expect(replica.table('edge').count).toBe(stats.edges);
    expect(replica.table('district').count).toBe(tables.district.ids.length);
    expect(replica.table('city').count).toBe(tables.city.ids.length);
    const refs: [Parameters<typeof replica.table>[0], string][] = [
      ['file', 'unit'], ['unit', 'district'], ['edge', 'src'], ['edge', 'dst'], ['district', 'city'],
    ];
    for (const [kind, col] of refs) {
      const t = replica.table(kind);
      expect(t.slots().every((s) => t.refSlots[col][s] >= 0), `${kind}.${col}`).toBe(true);
    }
    // Every column is present and full; ids are unique; no community is empty.
    for (const chunk of Object.values(tables)) {
      expect(new Set(chunk.ids).size).toBe(chunk.ids.length);
      for (const col of Object.values(chunk.cols)) expect(col).toHaveLength(chunk.ids.length);
    }
    expect(Object.keys(tables.unit.cols)).toHaveLength(9);
    expect(Object.keys(tables.edge.cols)).toHaveLength(7);
    expect(new Set(tables.unit.cols.district)).toEqual(new Set(tables.district.ids));
    expect(new Set(tables.district.cols.city)).toEqual(new Set(tables.city.ids));
    expect(tables.unit.cols.importancePct!.every((p) => p >= 0 && p <= 1)).toBe(true);
  });

  it('strongest kind wins and references add log(1 + count) to the weight', () => {
    const files = sortFiles([file('a.fk'), file('b.fk'), file('c.fk')]);
    const units = buildUnits(files);
    const edges = aggregateEdges([
      { src: 'a.fk', dst: 'b.fk', kind: 'call', confidence: 0.6, count: 4 },
      { src: 'a.fk', dst: 'b.fk', kind: 'import', confidence: 0.9 },
      { src: 'a.fk', dst: 'b.fk', kind: 'reference', confidence: 0.3, count: 3 },
      { src: 'c.fk', dst: 'a.fk', kind: 'inherit', confidence: 1 },
      { src: 'c.fk', dst: 'a.fk', kind: 'bridge', confidence: 1, mechanism: 'jni' },
      { src: 'b.fk', dst: 'b.fk', kind: 'call', confidence: 1 },
    ], units);
    expect(edges.count).toBe(2);
    expect([edges.kind[0], edges.confidence[0]]).toEqual(['call', 0.9]);
    expect(edges.weight[0]).toBeCloseTo(1 + Math.log(1 + 7), 12);
    expect([edges.kind[1], edges.mechanism[1]]).toEqual(['bridge', 'jni']);
  });
});

describe('placeholder clustering', () => {
  const min = config.clustering.minDistrictSize;
  const big = Array.from({ length: min }, (_, i) => file(`web/src/f${i}.fk`));
  const small = min > 1 ? [file('web/tiny/t.fk')] : [];
  const base = [...big, ...small, file('web/top.fk'), file('docs/guide.md'), file('main.fk')];

  it('makes cities from top-level folders and districts from second-level folders', () => {
    const { city, district, unit } = run(base).tables;
    expect(city.ids).toEqual(['.', 'docs', 'web']);
    expect(city.cols.name).toEqual(['demo', 'docs', 'web']);
    expect(district.ids).toEqual(['.', 'docs', 'web', 'web/src']);
    expect(district.cols.city).toEqual(['.', 'docs', 'web', 'web']);
    expect(district.cols.name).toEqual(['demo', 'docs', 'web', 'src']);
    const of = (id: string) => unit.cols.district![unit.ids.indexOf(id)];
    expect(of('web/src/f0.fk')).toBe('web/src');
    expect(of('web/top.fk')).toBe('web');
    if (min > 1) expect(of('web/tiny/t.fk')).toBe('web');
    expect(of('main.fk')).toBe('.');
  });

  it('keeps previous city and district ids for communities that persist', () => {
    const first = run(base).tables;
    const old = (id: string) => `old:${id}`;
    const previous: NonNullable<AnalysisInput['previous']> = { unitDistrict: {}, districtCity: {}, districtName: {}, cityName: {} };
    first.unit.ids.forEach((id, i) => { previous.unitDistrict[id] = old(first.unit.cols.district![i]); });
    first.district.ids.forEach((id, i) => {
      previous.districtCity[old(id)] = old(first.district.cols.city![i]);
      previous.districtName[old(id)] = first.district.cols.name![i];
    });
    first.city.ids.forEach((id, i) => { previous.cityName[old(id)] = first.city.cols.name![i]; });

    const next = run([...base, file('web/src/added.fk'), file('fresh/new.fk')], { previous }).tables;
    expect(next.city.ids).toEqual([...first.city.ids.map(old), 'fresh'].sort());
    expect(next.district.ids).toEqual([...first.district.ids.map(old), 'fresh'].sort());
    const of = (id: string) => next.unit.cols.district![next.unit.ids.indexOf(id)];
    for (const [i, id] of first.unit.ids.entries()) expect(of(id)).toBe(old(first.unit.cols.district![i]));
    expect(of('web/src/added.fk')).toBe('old:web/src');
    expect(next.district.cols.city![next.district.ids.indexOf('old:web/src')]).toBe('old:web');
  });
});
