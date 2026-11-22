import { describe, expect, it } from 'vitest';
import type { FileFacts } from '../../contracts/lang';
import { createRepoIndex } from '../../shared/repoIndex';
import { fixtureExpected, fixtureFiles } from '../../testing/fixture';
import { grammarPath, runQuery, type QueryCapture } from '../../testing/treesitter';
import swift, { createSwiftResolver, parsePackageManifest, scanSwift, SWIFT_QUERY } from './index';

interface Expected {
  imports: [string, string][];
  notImports: [string, string][];
  calls: [string, string, string][];
  sameModule: [string, string][];
}

/** Facts as the fast pass would build them: .swift files scanned, Package.swift also kept as an excerpt. */
const facts = (path: string, text = ''): FileFacts => path.endsWith('.swift')
  ? { path, oid: '', bytes: text.length, lang: 'swift', loc: text.split('\n').length, ...swift.scan(text, path), ...(path.endsWith('Package.swift') ? { excerpt: text } : {}) }
  : { path, oid: '', bytes: text.length, lang: null, loc: 0, imports: [] };

const files = fixtureFiles('swift');
const expected = fixtureExpected<Expected>('swift');
const index = createRepoIndex(Object.keys(files).sort().map((path) => facts(path, files[path])));
const resolver = createSwiftResolver(index);
const scope = (path: string): string[] => resolver.scopes!(index.get(path)!);

describe('swift scanner', () => {
  it('reads every import form and the top-level type names', () => {
    const text = [
      'import Foundation',
      '@testable import Core',
      '@_exported import struct Core.Money',
      '@_spi(Internal) public import Networking; import class UIKit.UIView',
      '#if canImport(Combine)',
      '  import Combine',
      '#endif',
      'import func Darwin.C.exit',
      '',
      'public final class Session: NSObject {',
      '  struct Nested {}',
      '  class func make() -> Session { Session() }',
      '}',
      'extension Session: Sendable {}',
      'enum Mode { case fast }',
      'protocol Store: AnyObject {}',
      'actor Cache {}',
      'typealias Handler = (Session) -> Void',
      'let important = registry.import(source)',
    ].join('\n');
    expect(scanSwift(text)).toEqual({
      imports: [
        { spec: 'Foundation', kind: 'import' },
        { spec: 'Core', kind: 'testable' },
        { spec: 'Core', kind: 'exported', names: ['Money'] },
        { spec: 'Networking', kind: 'import' },
        { spec: 'UIKit', kind: 'import', names: ['UIView'] },
        { spec: 'Combine', kind: 'import' },
        { spec: 'Darwin.C', kind: 'import', names: ['exit'] },
      ],
      decls: { classes: ['Session', 'Mode', 'Store', 'Cache', 'Handler'] },
    });
  });

  it('ignores imports in comments and strings, and never throws', () => {
    const text = [
      '// import InLineComment',
      '/* import InBlock',
      '   /* import Nested */',
      '   import AfterNested',
      '*/',
      'let a = "import InString"',
      'let b = """',
      '  import InMultiline',
      '  struct NotAType {}',
      '  """',
      'let c = #"a "quoted" import InRaw"# + ##"""',
      'import InRawMultiline "\\(x)" """',
      '"""##',
      'let d = "\\(render("import Interpolated { "))"',
      'import Real',
      'struct AfterStrings {}',
    ].join('\n');
    expect(scanSwift(text)).toEqual({ imports: [{ spec: 'Real', kind: 'import' }], decls: { classes: ['AfterStrings'] } });
    expect(scanSwift(files['Sources/Core/Money.swift']).imports).toEqual([{ spec: 'Foundation', kind: 'import' }]);
    expect(scanSwift(files['Sources/App/Checkout.swift']).imports.map((i) => i.spec)).toEqual(['Foundation', 'Core']);
    for (const bad of ['import', 'import struct', '@testable', '"""', '#"', '/*', '"\\(', '"\\("\\("\\(', '@x(', '`', 'class', '}}}{']) {
      expect(() => scanSwift(bad)).not.toThrow();
      expect(() => parsePackageManifest(bad + ' .target(name: "x"')).not.toThrow();
    }
  });
});

describe('swift modules', () => {
  it('reads targets and custom paths from Package.swift', () => {
    expect(parsePackageManifest(files['Package.swift'])).toEqual({
      name: 'Shop',
      targets: [
        { name: 'Core', kind: 'source' },
        { name: 'Storefront', kind: 'source', path: 'Sources/App' },
        { name: 'CoreTests', kind: 'test' },
      ],
    });
  });

  it('gives the files of one module one scope key, and other modules another', () => {
    for (const [a, b] of expected.sameModule) expect(scope(a), `${a} and ${b}`).toEqual(scope(b));
    // In Swift every import crosses a module boundary.
    for (const [src, dst] of expected.imports) expect(scope(src), `${src} and ${dst}`).not.toEqual(scope(dst));
    expect(scope('Sources/Core/Pricing/PriceRule.swift')).toEqual(['swift:Core']);
    expect(scope('Sources/App/Checkout.swift')).toEqual(['swift:Storefront']);
    expect(scope('Tests/CoreTests/Fixtures.swift')).toEqual(['swift:CoreTests']);
    expect(scope('Package.swift')).toEqual([]);
  });

  it('falls back to folders when there is no usable manifest', () => {
    const plain = createRepoIndex([
      'ios/Shop.xcodeproj/project.pbxproj', 'ios/Shop/AppDelegate.swift', 'ios/Shop/Views/CartView.swift', 'ios/ShopTests/CartViewTests.swift',
      'tools/lint/main.swift', 'tools/lint/Rules/Rule.swift',
      'pkg/Package.swift', 'pkg/Sources/Kit/Kit.swift', 'pkg/Sources/Kit/Deep/Util.swift', 'pkg/Tests/KitTests/KitTests.swift',
    ].map((path) => facts(path)));
    const r = createSwiftResolver(plain);
    const key = (path: string) => r.scopes!(plain.get(path)!);
    expect(key('ios/Shop/Views/CartView.swift')).toEqual(key('ios/Shop/AppDelegate.swift'));
    expect(key('ios/Shop/Views/CartView.swift')).toEqual(['swift:ios/Shop']);
    expect(key('ios/ShopTests/CartViewTests.swift')).toEqual(['swift:ios/ShopTests']);
    expect(key('tools/lint/Rules/Rule.swift')).toEqual(key('tools/lint/main.swift'));
    expect(key('pkg/Sources/Kit/Deep/Util.swift')).toEqual(['swift:pkg/Kit']);
    expect(key('pkg/Tests/KitTests/KitTests.swift')).toEqual(['swift:pkg/KitTests']);
    // A test file finds its subject by name; a module import otherwise stands on the module's own file.
    const to = (from: string, spec: string) => r.resolve(plain.get(from)!, { spec, kind: 'import' }).map((x) => x.path);
    expect(to('ios/ShopTests/CartViewTests.swift', 'Shop')).toEqual(['ios/Shop/Views/CartView.swift']);
    expect(to('pkg/Tests/KitTests/KitTests.swift', 'Kit')).toEqual(['pkg/Sources/Kit/Kit.swift']);
    expect(to('ios/Shop/AppDelegate.swift', 'Kit')).toEqual(['pkg/Sources/Kit/Kit.swift']);
    expect(to('ios/Shop/AppDelegate.swift', 'Shop')).toEqual([]);
    expect(to('ios/Shop/AppDelegate.swift', 'UIKit')).toEqual([]);
  });
});

describe('swift resolver', () => {
  it('resolves the fixture imports to exactly the expected edges', () => {
    const edges = new Set<string>();
    for (const file of index.byLang('swift')) {
      for (const imp of file.imports) {
        const hits = resolver.resolve(file, imp);
        if (['Foundation', 'XCTest', 'PackageDescription'].includes(imp.spec)) expect(hits, `${file.path}: ${imp.spec}`).toEqual([]);
        expect(hits.length).toBeLessThanOrEqual(3);
        for (const hit of hits) {
          expect(index.has(hit.path)).toBe(true);
          expect(hit.confidence).toBeGreaterThan(0);
          expect(hit.confidence).toBeLessThan(1);
          edges.add(`${file.path} -> ${hit.path}`);
        }
      }
    }
    expect([...edges].sort()).toEqual(expected.imports.map(([src, dst]) => `${src} -> ${dst}`).sort());
    for (const [src, dst] of expected.notImports) expect(edges.has(`${src} -> ${dst}`), `${src} -> ${dst}`).toBe(false);
  });
});

describe('swift query', () => {
  /** "kind name" for every definition and reference, pairing each @name with the capture that starts on its line and holds it. */
  const symbols = (captures: QueryCapture[]): string[] => {
    const out: string[] = [];
    for (const name of captures) {
      if (name.capture !== 'name') continue;
      for (const c of captures) {
        if (c.line === name.line && /^(definition|reference)\./.test(c.capture) && c.text.includes(name.text)) out.push(`${c.capture} ${name.text}`);
      }
    }
    return out;
  };
  const run = async (path: string): Promise<string[]> => symbols(await runQuery('swift', SWIFT_QUERY, files[path]));

  it('captures definitions, calls, type uses and conformances', async () => {
    expect(grammarPath('swift')).not.toBeNull();
    expect(swift.syntax!.grammar('Sources/Core/Cart.swift')).toBe('swift');

    const cart = await run('Sources/Core/Cart.swift');
    for (const want of [
      'definition.class Cart', 'definition.method init', 'definition.method add', 'definition.method total',
      'reference.type LineItem', 'reference.type PriceRule', 'reference.type Money', 'reference.type Core',
      'reference.call zero', 'reference.call adding', 'reference.call subtotal', 'reference.call adjust',
    ]) expect(cart, want).toContain(want);

    const rule = await run('Sources/Core/Pricing/PriceRule.swift');
    for (const want of ['definition.interface PriceRule', 'definition.struct PercentOff', 'definition.method adjust', 'reference.inherit PriceRule']) {
      expect(rule, want).toContain(want);
    }

    const sample = await runQuery('swift', SWIFT_QUERY, [
      'extension Money: Comparable {',
      '  private func cheaper(than other: Money) -> Bool { Ledger.shared.compare(self, other) }',
      '}',
      'func audit(_ cart: Cart) -> Receipt { let r = Receipt(id: UUID(), total: cart.total()); return r }',
      'enum Kind: String { case a }',
      'typealias Totals = [Kind: Money]',
    ].join('\n'));
    const found = symbols(sample);
    for (const want of [
      'reference.type Money', 'reference.inherit Comparable', 'definition.method cheaper', 'reference.type Ledger', 'reference.call compare',
      'definition.function audit', 'reference.type Receipt', 'reference.call total', 'definition.enum Kind', 'definition.type Totals',
    ]) expect(found, want).toContain(want);
    expect(found).not.toContain('definition.class Money');
    const texts = (capture: string) => sample.filter((c) => c.capture === capture).map((c) => c.text);
    expect(texts('container')).toEqual(['Money']); // the extension's method belongs to the extended type
    expect(texts('qualifier')).toEqual(['cart']);
    expect(texts('local')).toEqual(['private']);
  });

  it('sees both ends of every expected call in the fixture', async () => {
    const cache = new Map<string, string[]>();
    const of = async (path: string) => cache.get(path) ?? cache.set(path, await run(path)).get(path)!;
    for (const [src, dst, symbol] of expected.calls) {
      expect(await of(src), `${src} calls ${symbol}`).toContain(`reference.call ${symbol}`);
      const defs = await of(dst);
      expect(defs.includes(`definition.method ${symbol}`) || defs.includes(`definition.function ${symbol}`), `${dst} defines ${symbol}`).toBe(true);
    }
  });
});
