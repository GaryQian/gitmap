import { describe, expect, it } from 'vitest';
import { Parser, Query } from 'web-tree-sitter';
import type { FileFacts } from '../../contracts/lang';
import { createRepoIndex } from '../../shared/repoIndex';
import { fixtureExpected, fixtureFiles } from '../../testing/fixture';
import { grammarPath, loadGrammar, runQuery } from '../../testing/treesitter';
import go, { createGoResolver, scanGo } from './index';

interface Expected {
  imports: [string, string][];
  notImports: [string, string][];
  calls: [string, string, string][];
  samePackage: [string, string][];
}

/** Facts as the fast pass would build them: .go files scanned, go.mod kept as an excerpt. */
const facts = (path: string, text: string): FileFacts => path.endsWith('.go')
  ? { path, oid: '', bytes: text.length, lang: 'go', loc: text.split('\n').length, ...go.scan(text, path) }
  : { path, oid: '', bytes: text.length, lang: null, loc: 0, imports: [], excerpt: text };

describe('go scanner', () => {
  it('reads the package clause and every import form, keeping aliases', () => {
    const text = [
      '// Copyright. import "comment/one"',
      '/* import "comment/two" */',
      '//go:build linux',
      '',
      'package main // import "example.com/canonical"',
      '',
      'import "fmt"',
      'import str "strings"',
      'import (',
      '\t"os"',
      '\t. "math" // dot import',
      '\t_ "embed"',
      '\t/* "commented/out" */',
      '\tyaml "gopkg.in/yaml.v3"; "net/http"',
      '\traw `example.com/raw`',
      ')',
      'import ()',
      'import "C"',
      '',
      'func main() {}',
    ].join('\n');
    expect(scanGo(text)).toEqual({
      decls: { package: ['main'] },
      imports: [
        { spec: 'fmt', kind: 'import' },
        { spec: 'strings', kind: 'import', names: ['str'] },
        { spec: 'os', kind: 'import' },
        { spec: 'math', kind: 'import', names: ['.'] },
        { spec: 'embed', kind: 'import', names: ['_'] },
        { spec: 'gopkg.in/yaml.v3', kind: 'import', names: ['yaml'] },
        { spec: 'net/http', kind: 'import' },
        { spec: 'example.com/raw', kind: 'import', names: ['raw'] },
        { spec: 'C', kind: 'import' },
      ],
    });
  });

  it('does not take strings that mention import for imports, and survives truncated input', () => {
    const text = [
      'package gen',
      '',
      'import "text/template"',
      '',
      'const header = "import \\"example.com/in/string\\""',
      'var tmpl = template.Must(template.New("x").Parse(`package {{.}}',
      '',
      'import "example.com/in/raw"',
      'import (',
      '\t"example.com/in/raw/group"',
      ')',
      '`))',
      '',
      '// import "example.com/in/comment"',
      'func f() string { return "\\n" + `',
      'import alias "example.com/in/raw2"` }',
    ].join('\n');
    expect(scanGo(text).imports).toEqual([{ spec: 'text/template', kind: 'import' }]);
    for (let cut = 0; cut <= text.length; cut++) expect(() => scanGo(text.slice(0, cut))).not.toThrow();
    for (const broken of ['import (', 'import ( "a" x', 'package', 'import "unterminated', '/* open']) expect(() => scanGo(broken)).not.toThrow();
  });
});

describe('go resolver', () => {
  it('maps an import to the module that declares its path, honouring a local replace', () => {
    const index = createRepoIndex([
      facts('go.mod', 'module example.com/mono\n\ngo 1.22\n'),
      facts('api/types.go', 'package api'),
      facts('api/types_test.go', 'package api'),
      facts('tools/go.mod', [
        'module example.com/mono/tools // a nested module',
        'require example.com/forked v1.0.0',
        'replace (',
        '\texample.com/forked v1.0.0 => ../third/forked',
        '\texample.com/remote => example.com/elsewhere v1.2.3',
        ')',
      ].join('\n')),
      facts('tools/cmd/main.go', 'package main'),
      facts('tools/gen/gen.go', 'package gen'),
      facts('third/forked/fork.go', 'package forked'),
      facts('third/forked/sub/sub.go', 'package sub'),
    ]);
    const resolver = createGoResolver(index);
    const to = (from: string, spec: string) => resolver.resolve(index.get(from)!, { spec, kind: 'import' }).map((r) => r.path);

    expect(to('tools/cmd/main.go', 'example.com/mono/tools/gen')).toEqual(['tools/gen/gen.go']);
    expect(to('tools/cmd/main.go', 'example.com/mono/api')).toEqual(['api/types.go']);
    expect(to('tools/cmd/main.go', 'example.com/forked')).toEqual(['third/forked/fork.go']);
    expect(to('tools/cmd/main.go', 'example.com/forked/sub')).toEqual(['third/forked/sub/sub.go']);
    expect(to('api/types.go', 'example.com/forked')).toEqual([]); // the replace belongs to the tools module
    for (const external of ['fmt', 'net/http', 'C', 'github.com/google/uuid', 'example.com/remote/x', 'example.com/monolith/api']) {
      expect(to('tools/cmd/main.go', external)).toEqual([]);
    }
  });
});

describe('go fixture', () => {
  const files = fixtureFiles('go');
  const expected = fixtureExpected<Expected>('go');
  const index = createRepoIndex(Object.keys(files).sort().map((path) => facts(path, files[path])));
  const resolver = createGoResolver(index);
  const confidence = new Map<string, number>();
  for (const file of index.byLang('go')) {
    for (const imp of file.imports) for (const hit of resolver.resolve(file, imp)) confidence.set(`${file.path} -> ${hit.path}`, hit.confidence);
  }

  it('resolves every import of a repo package to that package\'s non-test files, and nothing else', () => {
    expect([...confidence.keys()].sort()).toEqual(expected.imports.map(([src, dst]) => `${src} -> ${dst}`).sort());
    for (const [src, dst] of expected.notImports) expect(confidence.has(`${src} -> ${dst}`)).toBe(false);
    // A one-file package is an exact target; a file of a larger package is one candidate among several.
    expect(confidence.get('cmd/shopd/main.go -> internal/config/config.go')).toBe(1);
    expect(confidence.get('cmd/shopd/main.go -> internal/store/store.go')).toBeLessThan(1);
  });

  it('puts the files of a package directory, its tests included, in one scope', () => {
    const scope = (path: string) => resolver.scopes!(index.get(path)!);
    for (const [a, b] of expected.samePackage) expect(scope(a)).toEqual(scope(b));
    expect(scope('internal/store/store.go')).not.toEqual(scope('internal/server/server.go'));
  });

  /** One line per query match: 'definition.method Server.view', 'reference.call price.WithTax'. */
  async function tags(path: string): Promise<string[]> {
    const lang = await loadGrammar(go.syntax!.grammar(path)!);
    const parser = new Parser();
    parser.setLanguage(lang);
    const tree = parser.parse(files[path])!;
    const query = new Query(lang, go.syntax!.queries.go);
    try {
      return query.matches(tree.rootNode).map((m) => {
        const text = (name: string) => m.captures.find((c) => c.name === name)?.node.text;
        const kind = m.captures.find((c) => c.name.startsWith('definition.') || c.name.startsWith('reference.'))!.name;
        const owner = text('container') ?? text('qualifier');
        return `${kind} ${owner ? owner + '.' : ''}${text('name')}`;
      });
    } finally {
      query.delete();
      tree.delete();
      parser.delete();
    }
  }

  it('has a query that compiles and captures definitions, calls with their qualifier, and embedded types', async () => {
    expect(grammarPath('go')).not.toBeNull();
    const allowed = /^(name|qualifier|container|definition\.(function|method|interface|type|struct|constant|variable)|reference\.(call|type|inherit))$/;
    const captures = await runQuery('go', go.syntax!.queries.go, files['internal/server/routes.go']);
    expect(captures.length).toBeGreaterThan(0);
    expect(captures.filter((c) => !allowed.test(c.capture))).toEqual([]);

    const routes = await tags('internal/server/routes.go');
    for (const tag of [
      'definition.struct itemView', 'definition.method Server.view', 'definition.function writeJSON',
      'reference.inherit store.Item', 'reference.type store.Item', 'reference.type http.ResponseWriter', 'reference.type itemView',
      'reference.call price.WithTax', 'reference.call price.Format', 'reference.call writeJSON', 'reference.call errors.Is', 'reference.call s.view',
    ]) expect(routes).toContain(tag);

    const server = await tags('internal/server/server.go');
    for (const tag of ['definition.interface Catalogue', 'definition.method Catalogue.Get', 'definition.struct Server', 'definition.function New', 'definition.method Server.Handler']) {
      expect(server).toContain(tag);
    }
    const format = await tags('pkg/pricing/format.go');
    expect(format).toContain('definition.constant Currency');
    expect(await tags('internal/store/item.go')).toContain('definition.variable ErrNotFound');
  });

  it('gives the linker what each expected call needs: a call in src, a definition in dst, and a path between them', async () => {
    for (const [src, dst, symbol] of expected.calls) {
      const calls = (await tags(src)).filter((t) => t.startsWith('reference.call ') && (t.endsWith(' ' + symbol) || t.endsWith('.' + symbol)));
      expect(calls, `${src} calls ${symbol}`).not.toEqual([]);
      expect((await tags(dst)).some((t) => t.startsWith('definition.') && t.endsWith(' ' + symbol)), `${dst} defines ${symbol}`).toBe(true);
      const from = index.get(src)!;
      const imported = from.imports.filter((imp) => resolver.resolve(from, imp).some((hit) => hit.path === dst));
      if (imported.length) {
        // Through an import: the call is qualified by the import's alias or by the imported package's name.
        const bindings = imported.map((imp) => imp.names?.[0] ?? index.get(dst)!.decls!.package[0]);
        expect(calls.some((t) => bindings.some((b) => t === `reference.call ${b}.${symbol}`)), `${src}: ${calls.join(', ')}`).toBe(true);
      } else {
        expect(resolver.scopes!(from)).toEqual(resolver.scopes!(index.get(dst)!));
        expect(calls).toContain(`reference.call ${symbol}`);
      }
    }
  });
});
