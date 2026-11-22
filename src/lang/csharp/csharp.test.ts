import { describe, expect, it } from 'vitest';
import type { FileFacts } from '../../contracts/lang';
import { createRepoIndex } from '../../shared/repoIndex';
import { fixtureExpected, fixtureFiles } from '../../testing/fixture';
import { grammarPath, runQuery } from '../../testing/treesitter';
import csharp, { CSHARP_GRAMMAR, CSHARP_QUERY, NAMESPACE_CAP, createCSharpResolver, scanCSharp } from './index';

interface Expected {
  imports: [string, string][];
  notImports: [string, string][];
  calls: [string, string, string][];
  sameNamespace: [string, string][];
}

const facts = (path: string, text: string): FileFacts => ({ path, oid: '', bytes: text.length, lang: 'csharp', loc: 1, ...scanCSharp(text) });

const files = fixtureFiles('csharp');
const expected = fixtureExpected<Expected>('csharp');
const index = createRepoIndex(Object.entries(files).map(([path, text]) => facts(path, text)));
const resolver = createCSharpResolver(index);

/** Every resolved import of the fixture as 'src -> dst'. */
function resolvedEdges(): Set<string> {
  const edges = new Set<string>();
  for (const f of index.files) for (const imp of f.imports) for (const hit of resolver.resolve(f, imp)) edges.add(`${f.path} -> ${hit.path}`);
  return edges;
}

describe('csharp scanner', () => {
  it('reads using directives, namespaces and type names', () => {
    const scan = scanCSharp([
      `global using System.Text;`,
      `using System;`,
      `using static Shop.Util.Guard;`,
      `using Store = global::Shop.Data.OrderRepository;`,
      `using Pair = (int, int);`,
      `namespace Shop.Core {`,
      `  using Shop.Models;`,
      `  public partial class Engine<T> : Base where T : class {`,
      `    private enum State { Off, On }`,
      `    public delegate Task<int> Step(int n);`,
      `    void Run<U>() where U : class where T2 : struct { var record = 1; }`,
      `  }`,
      `  namespace Inner { public readonly record struct Point(int X, int Y); interface IShape { } }`,
      `}`,
    ].join('\n'));
    expect(scan.imports).toEqual([
      { spec: 'System.Text', kind: 'global-using' },
      { spec: 'System', kind: 'using' },
      { spec: 'Shop.Util.Guard', kind: 'using-static' },
      { spec: 'Shop.Data.OrderRepository', kind: 'using-alias', names: ['Store'] },
      { spec: 'Shop.Models', kind: 'using' },
    ]);
    expect(scan.decls).toEqual({
      namespace: ['Shop.Core', 'Shop.Core.Inner'],
      classes: ['Shop.Core.Engine', 'Shop.Core.Engine.State', 'Shop.Core.Engine.Step', 'Shop.Core.Inner.Point', 'Shop.Core.Inner.IShape'],
    });
    expect(scanCSharp('namespace A.B;\npublic record Order(int Id);\npublic class @class { }').decls).toEqual({ namespace: ['A.B'], classes: ['A.B.Order', 'A.B.class'] });
  });

  it('does not take using statements and declarations for imports', () => {
    const scan = scanCSharp([
      `using System.IO;`,
      `using var top = File.OpenRead("a");`,
      `await using (var other = Open()) { }`,
      `class Reader {`,
      `  void Read(string path) {`,
      `    using (var stream = File.OpenRead(path)) { }`,
      `    using var second = File.OpenRead(path);`,
      `    using Shop.Models;`,
      `  }`,
      `}`,
    ].join('\n'));
    expect(scan.imports).toEqual([{ spec: 'System.IO', kind: 'using' }]);
    expect(scan.decls).toEqual({ classes: ['Reader'] });
  });

  it('skips comments, preprocessor lines and every kind of string', () => {
    const scan = scanCSharp([
      `// using In.LineComment;`,
      `/* using In.BlockComment;`,
      `   namespace In.Comment { } */`,
      `#region using In.Region;`,
      `using Real.One;`,
      `class Strings {`,
      `  const string A = "\\"; using In.Regular; class InRegular { } //";`,
      `  const string B = @"`,
      `using In.Verbatim; ""quoted""`,
      `namespace In.Verbatim { class InVerbatim { } }";`,
      `  string C => $"{(true ? "}" : "{")} class InInterpolated {{ {Name,-4:x} ";`,
      `  string D => $@"{Path}\\"" class InBoth {{ }}";`,
      `  string E = """`,
      `    class InRaw { } "quoted" ""`,
      `    """;`,
      `  char F = '"'; char G = '\\''; char H = '{';`,
      `  class Nested { }`,
      `}`,
      `class After { }`,
    ].join('\n'));
    expect(scan.imports).toEqual([{ spec: 'Real.One', kind: 'using' }]);
    expect(scan.decls).toEqual({ classes: ['Strings', 'Strings.Nested', 'After'] });
  });

  it('never throws on broken input', () => {
    for (const text of ['', 'using', 'using static', 'namespace', 'class', 'record', 'delegate', 'using A = ', '}}}} using X;', '$"{{{', '@"', "'", '"""', 'delegate (', '$'.repeat(50), '$"{'.repeat(100)]) {
      expect(() => scanCSharp(text)).not.toThrow();
    }
  });
});

describe('csharp resolver', () => {
  it('resolves the fixture: every expected import, none of the excluded ones, nothing for System', () => {
    const edges = resolvedEdges();
    for (const [src, dst] of expected.imports) expect(edges, `${src} -> ${dst}`).toContain(`${src} -> ${dst}`);
    for (const [src, dst] of expected.notImports) expect(edges, `${src} -> ${dst}`).not.toContain(`${src} -> ${dst}`);
    for (const f of index.files) {
      expect(f.imports.length + (f.decls?.namespace?.length ?? 0), f.path).toBeGreaterThan(0);
      for (const imp of f.imports) {
        if (/^(System|Xunit)\b/.test(imp.spec)) expect(resolver.resolve(f, imp), `${f.path}: ${imp.spec}`).toEqual([]);
      }
    }
  });

  it('is sure of a named type and unsure of a namespace', () => {
    const service = index.get('src/Shop/Services/OrderService.cs')!;
    const hit = (spec: string) => resolver.resolve(service, service.imports.find((imp) => imp.spec === spec)!);
    expect(hit('Shop.Util.Guard')).toEqual([{ path: 'src/Shop/Util/Guard.cs', confidence: 1 }]);
    expect(hit('Shop.Data.OrderRepository')).toEqual([{ path: 'src/Shop/Data/OrderRepository.cs', confidence: 1 }]);
    const models = hit('Shop.Models');
    expect(models.map((h) => h.path).sort()).toEqual(['src/Shop/Models/Customer.cs', 'src/Shop/Models/Money.cs', 'src/Shop/Models/Order.cs']);
    for (const h of models) expect(h.confidence).toBeLessThan(1);
  });

  it('caps a large namespace at its nearest files, with lower confidence', () => {
    const big = Array.from({ length: NAMESPACE_CAP * 3 }, (_, k) => facts(`lib/part${k % 3}/Type${k}.cs`, `namespace Big; class Type${k} { }`));
    const small = facts('lib/Small.cs', 'namespace Small { class Only { } }');
    const user = facts('lib/part1/User.cs', 'using Big; using Small; namespace App { class User { } }');
    const r = createCSharpResolver(createRepoIndex([...big, small, user]));
    const [bigHits, smallHits] = user.imports.map((imp) => r.resolve(user, imp));
    expect(smallHits.map((h) => h.path)).toEqual(['lib/Small.cs']);
    expect(bigHits).toHaveLength(NAMESPACE_CAP);
    for (const h of bigHits) {
      expect(h.path.startsWith('lib/part1/')).toBe(true);
      expect(h.confidence).toBeLessThan(smallHits[0].confidence);
    }
  });

  it('gives files of one namespace a shared scope key', () => {
    const keys = (path: string) => resolver.scopes!(index.get(path)!);
    for (const [a, b] of expected.sameNamespace) {
      expect(keys(a).filter((k) => keys(b).includes(k)), `${a} / ${b}`).not.toHaveLength(0);
    }
    expect(keys('src/Shop/Models/Order.cs')).toEqual(['cs:Shop.Models']);
    expect(keys('src/Shop/Models/Order.cs').filter((k) => keys('src/Shop/Services/OrderService.cs').includes(k))).toEqual([]);
    // No namespace at all: the global one, shared with other such files.
    expect(resolver.scopes!(facts('Assets/Player.cs', 'public class Player { }'))).toEqual(resolver.scopes!(facts('Assets/Enemy.cs', 'public class Enemy { }')));
  });
});

describe('csharp slow-pass query', () => {
  const cache = new Map<string, ReturnType<typeof analyse>>();
  const capturesOf = (path: string) => {
    let hit = cache.get(path);
    if (!hit) cache.set(path, (hit = analyse(path)));
    return hit;
  };
  const analyse = async (path: string) => {
    const caps = await runQuery(CSHARP_GRAMMAR, CSHARP_QUERY, files[path]);
    // runQuery returns flat captures, so pair each @name with its definition/reference capture: either
    // the same node (type references) or the innermost enclosing one still waiting for a name.
    const pairs: { kind: string; name: string }[] = [];
    const open: string[] = [];
    const main = caps.filter((c) => c.capture !== 'container' && c.capture !== 'qualifier');
    for (let k = 0; k < main.length; k++) {
      const c = main[k], d = main[k + 1];
      if (d &&d.text === c.text && d.line === c.line && (c.capture === 'name') !== (d.capture === 'name')) {
        pairs.push({ kind: c.capture === 'name' ? d.capture : c.capture, name: c.text });
        k++;
      } else if (c.capture === 'name') pairs.push({ kind: open.pop() ?? '', name: c.text });
      else open.push(c.capture);
    }
    /** Names captured as `kind` ('definition.method', 'reference.call', …), in document order. */
    const names = (kind: string): string[] => pairs.filter((p) => p.kind === kind).map((p) => p.name);
    return { caps, names };
  };

  it('ships its grammar and is wired into the plug-in', () => {
    expect(grammarPath(CSHARP_GRAMMAR)).not.toBeNull();
    expect(csharp.id).toBe('csharp');
    expect(csharp.extensions).toEqual(['cs']);
    expect(csharp.syntax!.grammar('src/A.cs')).toBe(CSHARP_GRAMMAR);
    expect(csharp.syntax!.queries[CSHARP_GRAMMAR]).toBe(CSHARP_QUERY);
  });

  it('captures definitions, calls, type references and base types', async () => {
    const { caps, names } = await capturesOf('src/Shop/Services/OrderService.cs');
    expect(names('definition.class')).toEqual(['OrderService']);
    expect(names('definition.method')).toEqual(['OrderService', 'PlaceOrder']);
    expect(caps.filter((c) => c.capture === 'container').map((c) => c.text)).toEqual(['OrderService', 'OrderService']);
    expect(names('reference.inherit')).toEqual(['IOrderService']);
    expect(names('reference.call')).toEqual(['NotNull', 'NotNull', 'NotNull', 'Any', 'Total', 'Save', 'Remember']);
    expect(caps.filter((c) => c.capture === 'qualifier').map((c) => c.text)).toEqual(['_pricing', '_store']);
    expect(names('reference.type')).toEqual(expect.arrayContaining(['Store', 'PricingService', 'Money', 'Order', 'InvalidOperationException']));

    const money = await capturesOf('src/Shop/Models/Money.cs');
    expect(money.names('definition.enum')).toEqual(['Currency']);
    expect(money.names('definition.struct')).toEqual(['Money']);
    expect(money.names('definition.method')).toEqual(['Money', 'Plus', 'Times', 'Format']);
    const repo = await capturesOf('src/Shop/Data/OrderRepository.cs');
    expect(repo.names('reference.inherit')).toEqual(['IRepository']);
    expect((await capturesOf('src/Shop/Data/IRepository.cs')).names('definition.interface')).toEqual(['IRepository']);
  });

  it('sees each expected call as a reference in the caller and a method in the callee', async () => {
    for (const [src, dst, symbol] of expected.calls) {
      expect((await capturesOf(src)).names('reference.call'), `${src} calls ${symbol}`).toContain(symbol);
      expect((await capturesOf(dst)).names('definition.method'), `${dst} defines ${symbol}`).toContain(symbol);
    }
  });
});
