import { describe, expect, it } from 'vitest';
import type { FileFacts, SymbolDef, SymbolRef } from '../../contracts/lang';
import { extname } from '../../shared';
import { createRepoIndex } from '../../shared/repoIndex';
import { fixtureExpected, fixtureFiles } from '../../testing/fixture';
import { grammarPath, runQuery, type QueryCapture } from '../../testing/treesitter';
import plugins, { extractJvmSymbols, JAVA_QUERY, jvmResolver, scanJvm } from './index';

interface Expected {
  imports: [string, string][];
  notImports: [string, string][];
  calls: [string, string, string][];
  samePackage: [string, string][];
}

const files = fixtureFiles('jvm');
const expected = fixtureExpected<Expected>('jvm');
const pluginFor = (path: string) => plugins.find((p) => p.extensions.includes(extname(path)))!;
const facts: FileFacts[] = Object.keys(files).sort().map((path) => {
  const plugin = pluginFor(path);
  return { path, oid: '', bytes: files[path].length, lang: plugin.id, loc: files[path].split('\n').length, ...plugin.scan(files[path], path) };
});
const index = createRepoIndex(facts);
const resolver = jvmResolver(index);
const short = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
const byName = (name: string): string => Object.keys(files).find((p) => short(p) === name)!;

describe('jvm scanner', () => {
  it('reads package, imports and top-level declarations of each language', () => {
    expect(scanJvm([
      `package com.acme.app;`,
      `import com.acme.util.Strings;`,
      `import static com.acme.util.Maths.clamp;`,
      `import static com.acme.util.Maths.*;`,
      `import com.acme.model.*;`,
      `@Deprecated public final class App { static class Inner {} interface Hook {} }`,
      `enum Mode { A, B }`,
      `record Point(int x, int y) {}`,
    ].join('\n'), 'java')).toEqual({
      imports: [
        { spec: 'com.acme.util.Strings', kind: 'import' },
        { spec: 'com.acme.util.Maths.clamp', kind: 'static' },
        { spec: 'com.acme.util.Maths', kind: 'static', names: ['*'] },
        { spec: 'com.acme.model', kind: 'import', names: ['*'] },
      ],
      decls: { package: ['com.acme.app'], classes: ['App', 'Mode', 'Point'] },
    });

    expect(scanJvm([
      `package com.acme.app`,
      `import com.acme.model.User as Account`,
      `import com.acme.util.*`,
      `typealias Id = String`,
      `data class Session(val id: Id, val user: Account) { class Token; fun close() {} }`,
      `sealed interface Event`,
      `object Registry`,
      `fun <T> List<T>.second(): T = this[1]`,
      `const val LIMIT = 3`,
      `private fun hidden() = Unit`,
      `val listener = object : Runnable { override fun run() {} }`,
    ].join('\n'), 'kotlin')).toEqual({
      imports: [
        { spec: 'com.acme.model.User', kind: 'import' },
        { spec: 'com.acme.util', kind: 'import', names: ['*'] },
      ],
      decls: { package: ['com.acme.app'], classes: ['Id', 'Session', 'Event', 'Registry'], members: ['second', 'LIMIT', 'listener'] },
    });
  });

  it('ignores imports inside comments and strings', () => {
    const java = [
      `// import in.line.Comment;`,
      `/* import in.block.Comment; */`,
      `import real.One;`,
      `class A {`,
      `  String s = "import in.a.String;";`,
      `  String t = """`,
      `      import in.a.TextBlock;`,
      `      """;`,
      `  char c = '"';`,
      `}`,
    ].join('\n');
    expect(scanJvm(java, 'java').imports).toEqual([{ spec: 'real.One', kind: 'import' }]);

    const kotlin = [
      `/* outer /* nested */`,
      `import still.in.Comment`,
      `*/`,
      `import real.Two`,
      'val a = "${listOf("x").joinToString { "}" }}"',
      `val b = """`,
      `import in.a.RawString`,
      `"""`,
      'fun `import nothing here`() {}',
    ].join('\n');
    const scanned = scanJvm(kotlin, 'kotlin');
    expect(scanned.imports).toEqual([{ spec: 'real.Two', kind: 'import' }]);
    expect(scanned.decls?.members).toEqual(['a', 'b']); // the template and the back-quoted name did not derail the sweep
  });

  it('reads Scala selectors, wildcards and chained packages', () => {
    const scala = [
      `package com.acme`,
      `package reports`,
      `import com.acme.model.{`,
      `  Order,          // a comment inside the list`,
      `  LineItem => Item,`,
      `  Secret => _`,
      `}, com.acme.money._`,
      `import _root_.com.acme.util.Strings`,
      `import scala.collection.mutable.{Map => MMap, _}`,
      `object Main {`,
      `  import com.acme.io.Files.read`,
      `  class Nested`,
      `}`,
      `case class Row(id: Int)`,
    ].join('\n');
    expect(scanJvm(scala, 'scala')).toEqual({
      imports: [
        { spec: 'com.acme.model', kind: 'import', names: ['Order', 'LineItem'] },
        { spec: 'com.acme.money', kind: 'import', names: ['*'] },
        { spec: 'com.acme.util.Strings', kind: 'import' },
        { spec: 'scala.collection.mutable', kind: 'import', names: ['Map', '*'] },
        { spec: 'com.acme.io.Files.read', kind: 'import' },
      ],
      decls: { package: ['com.acme.reports'], classes: ['Main', 'Row'] },
    });
  });
});

describe('jvm resolver', () => {
  const edges = new Map<string, number>();
  for (const file of facts) {
    for (const imp of file.imports) {
      for (const hit of resolver.resolve(file, imp)) edges.set(`${file.path} -> ${hit.path}`, hit.confidence);
    }
  }

  it('serves the three plug-ins with one instance', () => {
    expect(plugins.map((p) => p.id)).toEqual(['java', 'kotlin', 'scala']);
    for (const p of plugins) expect(p.createResolver!(index)).toBe(resolver);
  });

  it('resolves the fixture imports across languages and nothing else', () => {
    expect(facts.length).toBe(13);
    for (const [src, dst] of expected.imports) expect(edges.has(`${src} -> ${dst}`), `${short(src)} -> ${short(dst)}`).toBe(true);
    for (const [src, dst] of expected.notImports) expect(edges.has(`${src} -> ${dst}`), `${short(src)} -/-> ${short(dst)}`).toBe(false);
    // Nothing beyond the expected list: JDK and library imports resolve to no file.
    expect([...edges.keys()].sort()).toEqual(expected.imports.map(([src, dst]) => `${src} -> ${dst}`).sort());
    // A named type is exact; a wildcard is a guess.
    const exact = edges.get(`${byName('CheckoutService.kt')} -> ${byName('Order.java')}`)!;
    const wild = edges.get(`${byName('PricingService.java')} -> ${byName('LineItem.java')}`)!;
    expect(exact).toBe(1);
    expect(wild).toBeGreaterThan(0);
    expect(wild).toBeLessThan(exact);
  });

  it('caps a wildcard import of a huge package', () => {
    const many: FileFacts[] = [];
    for (let k = 0; k < 300; k++) many.push({ path: `src/big/T${k}.java`, oid: '', bytes: 0, lang: 'java', loc: 1, imports: [], decls: { package: ['big'] } });
    const user: FileFacts = { path: 'src/app/Use.kt', oid: '', bytes: 0, lang: 'kotlin', loc: 1, imports: [{ spec: 'big', kind: 'import', names: ['*'] }], decls: { package: ['app'] } };
    const hits = jvmResolver(createRepoIndex([...many, user])).resolve(user, user.imports[0]);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.length).toBeLessThan(50);
    expect(Math.max(...hits.map((h) => h.confidence))).toBeLessThan(0.5);
    // a Java file with no scanned declarations is still found by its file name
    expect(jvmResolver(createRepoIndex([...many, user])).resolve(user, { spec: 'big.T7', kind: 'import' })).toEqual([{ path: 'src/big/T7.java', confidence: 1 }]);
  });

  it('puts files of one package in one scope, whatever their language', () => {
    const scopes = (path: string): string[] => resolver.scopes!(index.get(path)!);
    for (const [a, b] of expected.samePackage) {
      expect(scopes(a).length, short(a)).toBeGreaterThan(0);
      expect(scopes(a), `${short(a)} / ${short(b)}`).toEqual(scopes(b));
    }
    expect(scopes(byName('App.kt'))).not.toEqual(scopes(byName('Strings.kt')));
    expect(scopes(byName('Money.java'))).toEqual(['jvm:com.example.shop.money']);
  });
});

// ---- slow pass ----

/** Name declared by a `definition.*` capture, read from the node text. */
function definedName(c: QueryCapture): string | undefined {
  const rx = c.capture === 'definition.method' ? /([A-Za-z_]\w*)\s*\(/ : /\b(?:class|interface|enum|record)\s+(\w+)/;
  return rx.exec(c.text)?.[1];
}
/** Method name of a `reference.call` capture: the identifier before the argument list that ends the node. */
function calledName(c: QueryCapture): string | undefined {
  let depth = 0;
  for (let i = c.text.length - 1; i >= 0; i--) {
    const ch = c.text[i];
    if (ch === ')') depth++;
    else if (ch === '(' && --depth === 0) return /(\w+)\s*$/.exec(c.text.slice(0, i))?.[1];
  }
  return undefined;
}

async function symbolsOf(path: string): Promise<{ defs: string[]; refs: string[] }> {
  if (extname(path) !== 'java') {
    const { defs, refs } = pluginFor(path).extractSymbols!(files[path], path);
    return { defs: defs.map((d) => d.name), refs: refs.filter((r) => r.kind === 'call' || r.kind === 'type').map((r) => r.name) };
  }
  const captures = await runQuery('java', JAVA_QUERY, files[path]);
  const defs = captures.filter((c) => c.capture.startsWith('definition.')).map((c) => definedName(c)!);
  const refs = captures.filter((c) => c.capture === 'reference.call').map((c) => calledName(c)!);
  return { defs, refs };
}

describe('jvm slow pass', () => {
  it('captures Java definitions, calls and supertypes with the tree-sitter query', async () => {
    expect(grammarPath('java')).not.toBeNull();
    expect(pluginFor('A.java').syntax!.grammar('A.java')).toBe('java');
    const captures = await runQuery('java', JAVA_QUERY, files[byName('Money.java')]);
    const of = (capture: string): QueryCapture[] => captures.filter((c) => c.capture === capture);

    expect(of('definition.class').map(definedName)).toEqual(['Money']);
    // each method and constructor once, the constructor as a method
    expect(of('definition.method').map(definedName)).toEqual(['Money', 'zero', 'of', 'plus', 'times', 'amount', 'compareTo', 'toString']);
    expect(of('container').every((c) => c.text === 'Money')).toBe(true);

    const calls = of('reference.call').map(calledName);
    expect(calls.filter((n) => n === 'round').length).toBe(2);
    expect(calls).toContain('compareTo');
    expect(calls).not.toContain('format'); // only in a comment
    expect(calls).not.toContain('of');     // only in a string
    expect(of('qualifier').map((c) => c.text)).toContain('Currencies');
    expect(of('reference.inherit').map((c) => c.text)).toEqual(['implements Comparable<Money>']);
    const typeNames = of('reference.type').map((c) => c.text);
    expect(typeNames).toContain('BigDecimal');
    expect(typeNames).toContain('@Override');

    const status = await runQuery('java', JAVA_QUERY, files[byName('OrderStatus.java')]);
    expect(status.filter((c) => c.capture === 'definition.enum').map(definedName)).toEqual(['OrderStatus']);
    const item = await runQuery('java', JAVA_QUERY, files[byName('LineItem.java')]);
    expect(item.filter((c) => c.capture.startsWith('definition.')).map(definedName)).toEqual(['LineItem', 'total']);
    const pricer = await runQuery('java', JAVA_QUERY, files[byName('Pricer.java')]);
    expect(pricer.filter((c) => c.capture.startsWith('definition.')).map(definedName)).toEqual(['Pricer', 'price']);
  });

  it('extracts Kotlin definitions and references without a grammar', () => {
    const def = (defs: SymbolDef[], name: string): SymbolDef | undefined => defs.find((d) => d.name === name);
    const ref = (refs: SymbolRef[], name: string, kind: string): SymbolRef | undefined => refs.find((r) => r.name === name && r.kind === kind);

    const checkout = extractJvmSymbols(files[byName('CheckoutService.kt')], 'kotlin');
    expect(checkout.defs.map((d) => `${d.kind} ${d.name}`)).toEqual(['class CheckoutService', 'method receiptFor', 'method checkout', 'method log']);
    expect(def(checkout.defs, 'CheckoutService')).toMatchObject({ line: 9, doc: 'Takes an order through pricing and payment.' });
    expect(def(checkout.defs, 'checkout')).toMatchObject({ container: 'CheckoutService', signature: 'suspend fun checkout(order: Order): PaymentResult' });
    expect(def(checkout.defs, 'checkout')!.exported).not.toBe(false);
    expect(def(checkout.defs, 'log')!.exported).toBe(false);
    expect(ref(checkout.refs, 'ReceiptSource', 'inherit')).toMatchObject({ count: 1 });
    expect(ref(checkout.refs, 'price', 'call')).toMatchObject({ qualifier: 'pricer' });
    expect(ref(checkout.refs, 'id', 'call')).toMatchObject({ count: 1 }); // the one in the string template is not counted
    expect(ref(checkout.refs, 'Order', 'type')).toMatchObject({ count: 2 });
    expect(ref(checkout.refs, 'PaymentResult', 'type')!.count).toBeGreaterThanOrEqual(3);
    expect(checkout.refs.some((r) => r.name === 'Formatter' || r.name === 'CheckoutService' || r.name === 'if')).toBe(false);

    const receipt = extractJvmSymbols(files[byName('Receipt.kt')], 'kotlin');
    expect(receipt.defs.map((d) => `${d.kind} ${d.name}`)).toEqual([
      'type ReceiptId', 'class Receipt', 'method render', 'interface ReceiptSource', 'method receiptFor',
      'interface PaymentResult', 'class Paid', 'class Declined',
    ]);
    expect(def(receipt.defs, 'Declined')!.container).toBe('PaymentResult');
    expect(ref(receipt.refs, 'PaymentResult', 'inherit')).toMatchObject({ count: 2 });

    const strings = extractJvmSymbols(files[byName('Strings.kt')], 'kotlin');
    expect(strings.defs.map((d) => `${d.kind} ${d.name} ${d.exported !== false}`)).toEqual(['function slugify true', 'function initials true', 'function collapse false']);
  });

  it('extracts Scala definitions and references without a grammar', () => {
    const report = extractJvmSymbols(files[byName('Report.scala')], 'scala');
    expect(report.defs.map((d) => `${d.kind} ${d.name} ${d.container ?? '-'}`)).toEqual([
      'trait Reporter -', 'method summary Reporter', 'class SalesReport -', 'method count SalesReport', 'method total SalesReport', 'method summary SalesReport',
    ]);
    expect(report.defs.find((d) => d.name === 'count')!.exported).toBe(false);
    expect(report.refs.filter((r) => r.kind === 'inherit').map((r) => r.name)).toEqual(['Reporter', 'Formatter']);
    expect(report.refs.find((r) => r.name === 'round' && r.kind === 'call')).toMatchObject({ qualifier: 'Currencies', count: 1 });
    expect(report.refs.some((r) => r.name === 'Order' && r.kind === 'type')).toBe(true);
    expect(report.refs.some((r) => r.name === 'LineItem')).toBe(false); // only named in the import

    const formatter = extractJvmSymbols(files[byName('Formatter.scala')], 'scala');
    expect(formatter.defs.map((d) => `${d.kind} ${d.name} ${d.container ?? '-'}`)).toEqual(['trait Formatter -', 'method line Formatter', 'module Formatter -', 'method pad Formatter']);

    // Scala 3 without braces: nesting follows indentation
    const braceless = extractJvmSymbols(['object Tools:', '  def twice(x: Int): Int =', '    def inner(y: Int) = y', '    inner(x) * 2', '', 'def top() = Tools.twice(1)'].join('\n'), 'scala');
    expect(braceless.defs.map((d) => `${d.kind} ${d.name} ${d.container ?? '-'} ${d.exported !== false}`)).toEqual([
      'module Tools - true', 'method twice Tools true', 'function inner - false', 'function top - true',
    ]);
  });

  it('finds every expected call as a reference in its source and a definition in its target', async () => {
    const cache = new Map<string, { defs: string[]; refs: string[] }>();
    const symbols = async (path: string) => {
      if (!cache.has(path)) cache.set(path, await symbolsOf(path));
      return cache.get(path)!;
    };
    for (const [src, dst, symbol] of expected.calls) {
      expect((await symbols(src)).refs, `${symbol} referenced in ${short(src)}`).toContain(symbol);
      expect((await symbols(dst)).defs, `${symbol} defined in ${short(dst)}`).toContain(symbol);
    }
  });
});
