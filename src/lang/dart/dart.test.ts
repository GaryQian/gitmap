import { describe, expect, it } from 'vitest';
import type { FileFacts } from '../../contracts/lang';
import { basename } from '../../shared';
import { createRepoIndex } from '../../shared/repoIndex';
import { fixtureExpected, fixtureFiles } from '../../testing/fixture';
import { grammarPath, runQuery } from '../../testing/treesitter';
import dart, { createDartResolver, readPubspec, scanDart } from './index';

interface Expected { imports: [string, string][]; notImports: [string, string][]; calls: [string, string, string][] }

const files = fixtureFiles('dart');
const expected = fixtureExpected<Expected>('dart');

/** The fixture as the fast pass would hand it over: Dart files scanned, pubspec.yaml files kept as text. */
function fixtureFacts(): FileFacts[] {
  return Object.entries(files).map(([path, text]) => {
    const isDart = path.endsWith('.dart');
    const facts: FileFacts = { path, oid: '', bytes: text.length, lang: isDart ? 'dart' : null, loc: text.split('\n').length, imports: [] };
    if (isDart) Object.assign(facts, dart.scan(text, path));
    else if (dart.manifests!.includes(basename(path))) facts.excerpt = text;
    return facts;
  });
}

describe('dart fixture', () => {
  const index = createRepoIndex(fixtureFacts());
  const resolver = dart.createResolver!(index);
  const edges = new Set<string>();
  for (const file of index.byLang('dart')) {
    for (const imp of file.imports) for (const hit of resolver.resolve(file, imp)) edges.add(`${file.path} -> ${hit.path}`);
  }

  it('resolves every expected import and nothing else', () => {
    const want = expected.imports.map(([src, dst]) => `${src} -> ${dst}`);
    expect([...edges].sort()).toEqual([...want].sort());
    for (const [src, dst] of expected.notImports) expect(edges.has(`${src} -> ${dst}`), `${src} -> ${dst}`).toBe(false);
  });

  it('captures the definitions and references the expected calls need', async () => {
    expect(grammarPath('dart')).not.toBeNull();
    const query = dart.syntax!.queries[dart.syntax!.grammar('lib/a.dart')!];
    const analyse = async (path: string) => {
      const caps = await runQuery('dart', query, files[path]);
      const all = (capture: string) => caps.filter((c) => c.capture === capture).map((c) => c.text);
      // A reference pattern puts @name and @reference.* on the same node; any other @name names a
      // definition (twice when the @local pattern matches it too).
      const defNames = caps.filter((c, k) => c.capture === 'name' && !caps[k + 1]?.capture.startsWith('reference.'));
      return {
        defs: defNames.filter((c, k) => !defNames.slice(0, k).some((d) => d.line === c.line && d.text === c.text)).map((c) => c.text),
        kinds: caps.filter((c) => c.capture.startsWith('definition.')).map((c) => c.capture.slice('definition.'.length)),
        all,
        refs: (kind: string) => all(`reference.${kind}`),
      };
    };
    for (const [src, dst, symbol] of expected.calls) {
      const from = await analyse(src);
      expect((await analyse(dst)).defs, `${symbol} defined in ${dst}`).toContain(symbol);
      expect([...from.refs('call'), ...from.refs('type')], `${symbol} referenced in ${src}`).toContain(symbol);
    }

    const product = await analyse('packages/shop_core/lib/src/models/product.dart');
    expect(product.defs).toEqual(['TaxClass', 'ProductId', 'Describable', 'label', 'describe', 'Product', 'fromJson', 'isTaxed', 'label', 'toJson', 'ProductListTotals', 'netCents']);
    expect(product.kinds).toEqual(['enum', 'type', 'trait', 'method', 'method', 'class', 'method', 'method', 'method', 'method', 'class', 'method']);
    expect(product.all('container')).toEqual(expect.arrayContaining(['Describable', 'Product', 'ProductListTotals']));
    expect(product.refs('inherit')).toEqual(['Describable']);
    expect(product.all('local')).toEqual([]);

    const page = await analyse('app/lib/src/cart_page.dart');
    expect(page.refs('inherit')).toEqual(['StatefulWidget', 'State', 'SingleTickerProviderStateMixin', 'Listenable']);
    expect(page.refs('call')).toEqual(expect.arrayContaining(['openStorage', 'save', 'setState', '_buildLine', 'builder']));
    expect(page.refs('call')).not.toContain('PriceTag');
    expect(page.refs('type')).toEqual(expect.arrayContaining(['Cart', 'CartLine', 'PriceTag', 'Scaffold', 'ListView', 'Icons']));
    expect(page.all('qualifier')).toEqual(expect.arrayContaining(['_storage', 'ListView']));
    expect(page.defs).toEqual(['LineBuilder', 'CartPage', 'createState', '_CartPageState', '_checkout', '_buildLine', 'build']);
    expect(page.all('local')).toHaveLength(3); // the three definitions whose names start with an underscore

    const pricing = await analyse('packages/shop_core/lib/src/pricing.dart');
    expect(pricing.defs).toEqual(['roundToCents', 'taxRate', 'lineTotal', 'formatPrice']);
    expect(pricing.kinds).toEqual(['function', 'function', 'function', 'function']);
  });
});

describe('dart scanner', () => {
  it('reads imports, exports, parts, combinators and the library name', () => {
    const scan = scanDart([
      `#!/usr/bin/env dart`,
      `// Copyright notice.`,
      `@TestOn('vm')`,
      `library my.lib;`,
      ``,
      `import 'dart:async';`,
      `import "package:a/a.dart" as a show First, Second hide Third;`,
      `import 'package:b/b.dart' deferred as b;`,
      `import r'c.dart' hide Hidden;`,
      `export 'src/d.dart' show D;`,
      `part 'e.g.dart';`,
      `class Later {}`,
      `import 'too_late.dart';`,
    ].join('\n'));
    expect(scan.imports).toEqual([
      { spec: 'dart:async', kind: 'import' },
      { spec: 'package:a/a.dart', kind: 'import', names: ['First', 'Second'] },
      { spec: 'package:b/b.dart', kind: 'import' },
      { spec: 'c.dart', kind: 'import' },
      { spec: 'src/d.dart', kind: 'export', names: ['D'] },
      { spec: 'e.g.dart', kind: 'part' },
    ]);
    expect(scan.decls).toEqual({ library: ['my.lib'] });
  });

  it('emits every URI of a conditional import', () => {
    const { imports } = scanDart([
      `import 'stub.dart'`,
      `    if (dart.library.io) 'io.dart'`,
      `    if (dart.library.js_interop == 'true') 'web.dart' as impl;`,
      `export 'a.dart' if (dart.library.html) 'b.dart' show X;`,
    ].join('\n'));
    expect(imports.map((i) => `${i.kind}:${i.spec}`)).toEqual(['import:stub.dart', 'import:io.dart', 'import:web.dart', 'export:a.dart', 'export:b.dart']);
    expect(imports[4].names).toEqual(['X']);
  });

  it('tells `part of` by URI from `part of` by library name', () => {
    expect(scanDart(`part of '../lib.dart';\nclass A {}`).imports).toEqual([{ spec: '../lib.dart', kind: 'part-of' }]);
    expect(scanDart(`// generated\npart of my.app.lib;\n`).imports).toEqual([{ spec: 'my.app.lib', kind: 'part-of-library' }]);
  });

  it('ignores directives inside comments and strings, and never throws', () => {
    const text = [
      `/* import 'block.dart'; /* nested */ import 'still_comment.dart'; */`,
      `/// import 'doc.dart';`,
      `@Usage('''`,
      `import 'in_multiline_string.dart';`,
      `''', r"import 'raw.dart'; \\", '\${note('import "interpolated.dart";')}')`,
      `import 'real.dart';`,
      `const text = '''`,
      `import 'after_code.dart';`,
      `''';`,
    ].join('\n');
    expect(scanDart(text).imports).toEqual([{ spec: 'real.dart', kind: 'import' }]);
    for (const broken of ['import', 'import \'', 'import \'a.dart\' if (', 'import \'a.dart\' show', 'part of', 'library', '@A(\'${', '/*', 'export "x" as', '@']) {
      expect(() => scanDart(broken)).not.toThrow();
    }
  });
});

describe('dart resolver', () => {
  const file = (path: string, text = ''): FileFacts => ({
    path, oid: '', bytes: 0, loc: 1, imports: [],
    ...(path.endsWith('.dart') ? { lang: 'dart', ...scanDart(text) } : { lang: null, excerpt: text }),
  });
  const index = createRepoIndex([
    file('pubspec.yaml', 'name: workspace_root\nworkspace:\n  - packages/core\n  - packages/ui\n'),
    file('packages/core/pubspec.yaml', 'name: acme_core # the shared package\nversion: 1.0.0\n'),
    file('packages/core/lib/core.dart', 'library acme.core;\npart "src/detail.dart";'),
    file('packages/core/lib/src/detail.dart', 'part of acme.core;'),
    file('packages/core/lib/src/orphan.dart', 'part of acme.core;'),
    file('packages/ui/pubspec.yaml', 'name: "acme_ui"\ndependencies:\n  acme_core: { path: ../core }\n  remote:\n    git:\n      url: https://example.com/remote.git\n      path: packages/core\n'),
    file('packages/ui/lib/ui.dart'),
    file('packages/ui/lib/src/button.dart'),
    file('packages/ui/test/button_test.dart'),
  ]);
  const resolver = createDartResolver(index);
  const to = (from: string, spec: string, kind = 'import') => resolver.resolve(index.get(from)!, { spec, kind });

  it('maps package: URIs to lib/ of the package with that name', () => {
    expect(to('packages/ui/test/button_test.dart', 'package:acme_ui/src/button.dart')).toEqual([{ path: 'packages/ui/lib/src/button.dart', confidence: 1 }]);
    expect(to('packages/ui/lib/ui.dart', 'package:acme_core/core.dart')).toEqual([{ path: 'packages/core/lib/core.dart', confidence: 1 }]);
    expect(to('packages/ui/lib/ui.dart', 'package:acme_core/missing.dart')).toEqual([]);
    expect(to('packages/ui/lib/ui.dart', 'package:flutter/material.dart')).toEqual([]);
    expect(to('packages/ui/lib/ui.dart', 'dart:ui')).toEqual([]);
  });

  it('resolves relative URIs and rejects ones that leave the repo', () => {
    expect(to('packages/ui/lib/ui.dart', 'src/button.dart').map((r) => r.path)).toEqual(['packages/ui/lib/src/button.dart']);
    expect(to('packages/ui/test/button_test.dart', '../lib/ui.dart').map((r) => r.path)).toEqual(['packages/ui/lib/ui.dart']);
    expect(to('packages/ui/lib/ui.dart', '../../../../outside.dart')).toEqual([]);
    expect(to('packages/ui/lib/ui.dart', 'ui.dart')).toEqual([]); // itself
  });

  it('links a part to its library by name, surer when the library lists the part', () => {
    expect(to('packages/core/lib/src/detail.dart', 'acme.core', 'part-of-library')).toEqual([{ path: 'packages/core/lib/core.dart', confidence: 1 }]);
    const orphan = to('packages/core/lib/src/orphan.dart', 'acme.core', 'part-of-library');
    expect(orphan.map((r) => r.path)).toEqual(['packages/core/lib/core.dart']);
    expect(orphan[0].confidence).toBeLessThan(1);
    expect(to('packages/core/lib/src/detail.dart', 'no.such.library', 'part-of-library')).toEqual([]);
  });

  it('reads the name and local path dependencies of a pubspec', () => {
    expect(readPubspec(index.text('packages/ui/pubspec.yaml')!)).toEqual({ name: 'acme_ui', pathDeps: { acme_core: '../core' } });
    expect(readPubspec('name: app\ndependencies:\n  flutter:\n    sdk: flutter\n  core:\n    path: "../core"\n')).toEqual({ name: 'app', pathDeps: { core: '../core' } });
  });
});
