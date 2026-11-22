import { describe, expect, it } from 'vitest';
import { config } from '../../config';
import type { FileFacts, ImportSpec, LanguagePlugin, RefKind, SymbolDef, SymbolKind, SymbolRef, SyntaxFacts } from '../../contracts/lang';
import { pluginForPath } from '../../lang';
import { edgeId } from '../../model';
import { fixtureExpected, fixtureFiles } from '../../testing/fixture';
import { analyze, LINK_CONFIDENCE, pairHeaders } from '../index';

// A fake language: an import's spec is the target path (several, separated by ',', for a package
// import); files of one `decls.package` share a scope, and a file reads the scopes in `decls.sees`.
const fake: LanguagePlugin = {
  id: 'fake', name: 'Fake', extensions: ['fk'], color: '#888888',
  scan: () => ({ imports: [] }),
  createResolver: () => ({
    resolve: (_file, imp) => imp.spec.split(',').map((path) => ({ path, confidence: 1 })),
    scopes: (file) => file.decls?.package ?? [],
    sees: (file) => file.decls?.sees ?? [],
  }),
};

function file(path: string, imports: (string | ImportSpec)[] = [], pkg?: string, sees?: string[]): FileFacts {
  return {
    path, oid: `oid-${path}`, bytes: 300, loc: 10, lang: 'fake',
    imports: imports.map((i) => (typeof i === 'string' ? { spec: i, kind: 'import' } : i)),
    ...(pkg ? { decls: { package: [pkg], ...(sees ? { sees } : {}) } } : {}),
  };
}
const def = (name: string, kind: SymbolKind = 'function', extra: Partial<SymbolDef> = {}): SymbolDef => ({ name, kind, line: 1, ...extra });
const ref = (name: string, kind: RefKind = 'call', count = 1, qualifier?: string): SymbolRef => ({ name, kind, count, ...(qualifier ? { qualifier } : {}) });
const syn = (path: string, defs: SymbolDef[], refs: SymbolRef[] = []): SyntaxFacts => ({ path, oid: `oid-${path}`, defs, refs });

function run(files: FileFacts[], syntax: SyntaxFacts[], syntaxComplete = true) {
  const result = analyze({ repoName: 'demo', files, syntax, syntaxComplete }, config, { plugins: [fake] });
  const { edge } = result.tables;
  const row = (src: string, dst: string) => {
    const i = edge.ids.indexOf(edgeId(src, dst));
    return i < 0 ? null : { kind: edge.cols.kind![i], weight: edge.cols.weight![i], confidence: edge.cols.confidence![i], symbols: edge.cols.symbols![i] };
  };
  return { result, row };
}

describe('symbol linking', () => {
  it('links a call through an import, names the symbol on the edge, and follows re-exports behind a barrel', () => {
    const files = [
      file('app.fk', [{ spec: 'lib.fk', kind: 'import', names: ['helper'] }, 'barrel.fk']),
      file('lib.fk'),
      file('barrel.fk', [{ spec: 'mid.fk', kind: 'export', names: ['*'] }]),
      file('mid.fk', [{ spec: 'deep.fk', kind: 'export', names: ['deepFn'] }, 'plain.fk']),
      file('deep.fk'),
      file('plain.fk'),
    ];
    const syntax = [
      syn('app.fk', [def('start'), def('twice')], [
        ref('helper', 'call', 3), ref('Thing', 'type'), ref('deepFn'), ref('start'), ref('twice'), ref('printf', 'call', 9),
        ref('notExported'), ref('notExported', 'type'),
      ]),
      syn('lib.fk', [def('helper'), def('Thing', 'class'), def('hidden', 'function', { exported: false }), def('twice')]),
      syn('deep.fk', [def('deepFn'), def('notExported')]),
      syn('plain.fk', [def('notExported')]),
    ];
    const { result, row } = run(files, syntax);
    expect(row('app.fk', 'lib.fk')).toEqual({
      kind: 'call', weight: 1 + Math.log(1 + 4), confidence: LINK_CONFIDENCE.named, symbols: 'helper:3|Thing:1',
    });
    expect(row('app.fk', 'deep.fk')).toMatchObject({ kind: 'call', confidence: LINK_CONFIDENCE.reexport, symbols: 'deepFn:1' });
    expect(row('app.fk', 'barrel.fk')).toMatchObject({ kind: 'import', symbols: '' });
    // `start` and `twice` are the file's own; `printf` is defined nowhere; `notExported` is neither
    // passed on by mid.fk's named re-export nor reachable through its plain import two hops away.
    expect(row('app.fk', 'plain.fk')).toBeNull();
    expect(result.diagnostics).toMatchObject({ refsLinked: 3, refsDropped: 3 });
    expect(result.structure).toBe('full');

    // Partial syntax still links what there is; the order of the inputs does not matter.
    const partial = run([...files].reverse(), [...syntax].reverse(), false).result;
    expect(partial.structure).toBe('imports-only');
    expect(partial.tables).toEqual(result.tables);
  });

  it('links a same-scope reference without an import', () => {
    const { row } = run(
      [file('p/a.fk', [], 'p'), file('p/b.fk', [], 'p'), file('q/c.fk', [], 'q')],
      [
        syn('p/a.fk', [], [ref('Shared', 'type', 2)]),
        syn('p/b.fk', [def('Shared', 'class')]),
        syn('q/c.fk', [def('Shared', 'class')]),
      ],
    );
    expect(row('p/a.fk', 'p/b.fk')).toEqual({ kind: 'reference', weight: Math.log(1 + 2), confidence: LINK_CONFIDENCE.scope, symbols: 'Shared:2' });
    expect(row('p/a.fk', 'q/c.fk')).toBeNull();
  });

  it('links into a scope the file can read (Resolver.sees), one way only', () => {
    const { row } = run(
      [file('app/a.fk', [], 'app', ['core']), file('app/b.fk', [], 'app'), file('core/c.fk', [], 'core'), file('other/d.fk', [], 'other')],
      [
        syn('app/a.fk', [def('AppThing', 'class')], [ref('CoreThing', 'type')]),
        syn('app/b.fk', [def('AppThing', 'class')]),
        syn('core/c.fk', [def('CoreThing', 'class')], [ref('AppThing', 'type')]),
        syn('other/d.fk', [def('CoreThing', 'class'), def('AppThing', 'class')]),
      ],
    );
    expect(row('app/a.fk', 'core/c.fk')).toEqual({ kind: 'reference', weight: Math.log(2), confidence: LINK_CONFIDENCE.import, symbols: 'CoreThing:1' });
    expect(row('core/c.fk', 'app/a.fk')).toBeNull();
    expect(row('core/c.fk', 'app/b.fk')).toBeNull();
  });

  it('links a globally unique name with lower confidence and drops an ambiguous one', () => {
    const { result, row } = run(
      [file('x.fk'), file('y.fk'), file('z.fk')],
      [
        syn('x.fk', [], [ref('uniqueThing'), ref('definedTwice'), ref('go')]),
        syn('y.fk', [def('uniqueThing'), def('definedTwice'), def('go')]),
        syn('z.fk', [def('definedTwice')]),
      ],
    );
    expect(row('x.fk', 'y.fk')).toMatchObject({ kind: 'call', confidence: LINK_CONFIDENCE.unique, symbols: 'uniqueThing:1' });
    expect(LINK_CONFIDENCE.unique).toBeLessThan(LINK_CONFIDENCE.scope);
    expect(result.tables.edge.ids).toHaveLength(1);
    expect(result.diagnostics).toMatchObject({ refsLinked: 1, refsDropped: 2 });
  });

  it('lets inherit outrank call on the same pair, and a qualifier pick the class it names', () => {
    const { row } = run(
      [file('a.fk', ['base.fk', 'other.fk']), file('base.fk'), file('other.fk')],
      [
        syn('a.fk', [], [ref('Base', 'inherit'), ref('Base', 'call', 5), ref('make', 'call', 1, 'Other')]),
        syn('base.fk', [def('Base', 'class'), def('make', 'method', { container: 'Base' })]),
        syn('other.fk', [def('make', 'method', { container: 'Other' })]),
      ],
    );
    expect(row('a.fk', 'base.fk')).toMatchObject({ kind: 'inherit', weight: 1 + Math.log(1 + 6), symbols: 'Base:6' });
    expect(row('a.fk', 'other.fk')).toMatchObject({ kind: 'call', symbols: 'make:1' });
  });

  it('binds a qualifier to an import by listed alias, declared package, then last path segment', () => {
    const { result, row } = run(
      [
        file('app/main.fk', [
          'shop/cartpkg/a.fk,shop/cartpkg/b.fk',                              // a package import: two files, package `cart`
          { spec: 'shop/order/o.fk', kind: 'import', names: ['ord'] },        // aliased
          'lib/util.fk', 'lib/other.fk',
        ], 'main'),
        file('shop/cartpkg/a.fk', [], 'cart'), file('shop/cartpkg/b.fk', [], 'cart'), file('shop/order/o.fk', [], 'order'),
        file('lib/util.fk'), file('lib/other.fk'),
      ],
      [
        syn('app/main.fk', [def('New')], [
          ref('New', 'call', 2, 'cart'), ref('Total', 'call', 1, 'cart'), ref('New', 'call', 1, 'ord'), ref('New'),
          ref('helper', 'call', 1, 'util'),
        ]),
        syn('shop/cartpkg/a.fk', [def('New')]), syn('shop/cartpkg/b.fk', [def('Total')]), syn('shop/order/o.fk', [def('New')]),
        syn('lib/util.fk', [def('helper')]), syn('lib/other.fk', [def('helper')]),
      ],
    );
    // `New` is defined by the file itself and by two imports; only the qualifier says which is meant.
    expect(row('app/main.fk', 'shop/cartpkg/a.fk')).toMatchObject({ kind: 'call', symbols: 'New:2' });
    expect(row('app/main.fk', 'shop/cartpkg/b.fk')).toMatchObject({ kind: 'call', symbols: 'Total:1' });
    expect(row('app/main.fk', 'shop/order/o.fk')).toMatchObject({ kind: 'call', symbols: 'New:1' });
    expect(row('app/main.fk', 'lib/util.fk')).toMatchObject({ kind: 'call', symbols: 'helper:1' });
    expect(row('app/main.fk', 'lib/other.fk')).toMatchObject({ kind: 'import', symbols: '' });
    expect(result.diagnostics).toMatchObject({ refsLinked: 4, refsDropped: 0 });
  });
});

describe('header pairing', () => {
  it('pairs the headers of the three-lang fixture and links a call to the paired unit', () => {
    const expected = fixtureExpected<{ headerPairs: [string, string][] }>('three-lang');
    const texts = fixtureFiles('three-lang');
    const files: FileFacts[] = Object.keys(texts).filter((p) => p.startsWith('native/')).map((path) => {
      const plugin = pluginForPath(path);
      return { path, oid: `oid-${path}`, bytes: texts[path].length, loc: texts[path].split('\n').length, lang: plugin?.id ?? null, imports: plugin?.scan(texts[path], path).imports ?? [] };
    });
    // What the slow pass would report for main.c and the engine pair.
    const syntax = [
      syn('native/main.c', [def('main')], [ref('engine_create')]),
      syn('native/engine.h', [def('engine_create')]),
      syn('native/engine.c', [def('engine_create')], [ref('log_info')]),
    ];
    const { tables } = analyze({ repoName: 'three-lang', files, syntax }, config);
    const unitOf = (path: string) => tables.file.cols.unit![tables.file.ids.indexOf(path)];
    for (const [header, impl] of expected.headerPairs) {
      expect(unitOf(header), header).toBe(impl);
      const u = tables.unit.ids.indexOf(impl);
      const loc = (path: string) => tables.file.cols.loc![tables.file.ids.indexOf(path)];
      expect(tables.unit.cols.fileCount![u]).toBe(2);
      expect(tables.unit.cols.loc![u]).toBe(loc(header) + loc(impl));
      expect(tables.unit.cols.lang![u]).toBe('c');
    }
    expect(tables.unit.ids).toEqual(['native/engine.c', 'native/main.c', 'native/util/log.c']);
    const e = tables.edge.ids.indexOf(edgeId('native/main.c', 'native/engine.c'));
    expect(tables.edge.cols.kind![e]).toBe('call');
    expect(tables.edge.cols.symbols![e]).toBe('engine_create:1');
  });

  it('prefers the implementation that includes the header, and pairs mirrored include/ and src/ trees', () => {
    const files = ['a/foo.c', 'a/foo.cpp', 'a/foo.h', 'lib/include/net/sock.hpp', 'lib/src/net/sock.cc', 'lib/src/other/sock.cc']
      .map((path) => file(path));
    const mapped = pairHeaders(files, [{ src: 'a/foo.cpp', dst: 'a/foo.h', kind: 'import', confidence: 1 }]);
    expect(mapped).toEqual(['a/foo.c', 'a/foo.cpp', 'a/foo.cpp', 'lib/src/net/sock.cc', 'lib/src/net/sock.cc', 'lib/src/other/sock.cc']);
  });
});
