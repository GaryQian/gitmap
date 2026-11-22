import { describe, expect, it } from 'vitest';
import type { FileFacts } from '../../contracts/lang';
import { createRepoIndex } from '../../shared/repoIndex';
import { fixtureExpected, fixtureFiles } from '../../testing/fixture';
import { grammarPath, runQuery } from '../../testing/treesitter';
import php, { PHP_QUERY, createPhpResolver, scanPhp } from './index';

interface Expected {
  imports: [string, string][];
  notImports: [string, string][];
  /** [file, spec]: a `use` of a framework or built-in class, which must resolve to nothing. */
  external: [string, string][];
  calls: [string, string, string][];
  sameNamespace: [string, string][];
}

const files = fixtureFiles('php');
const expected = fixtureExpected<Expected>('php');

/** Facts as the fast pass would build them: PHP files scanned, composer.json kept as text. */
const facts: FileFacts[] = Object.keys(files).map((path) => {
  const base = { path, oid: '', bytes: files[path].length, loc: 1 };
  return path.endsWith('.php')
    ? { ...base, lang: 'php', ...php.scan(files[path], path) }
    : { ...base, lang: null, imports: [], excerpt: files[path] };
});
const index = createRepoIndex(facts);
const resolver = php.createResolver!(index);

describe('php fixture', () => {
  const edges = new Set<string>();
  for (const file of facts) {
    for (const imp of file.imports) for (const hit of resolver.resolve(file, imp)) edges.add(`${file.path} -> ${hit.path}`);
  }

  it('resolves every expected import and none of the forbidden ones', () => {
    for (const [src, dst] of expected.imports) expect(edges, `${src} -> ${dst}`).toContain(`${src} -> ${dst}`);
    for (const [src, dst] of expected.notImports) expect(edges, `${src} -> ${dst}`).not.toContain(`${src} -> ${dst}`);
    expect(edges.size).toBe(expected.imports.length);
  });

  it('scans framework and built-in classes but resolves them to nothing', () => {
    for (const [src, spec] of expected.external) {
      const file = index.get(src)!;
      const imp = file.imports.find((i) => i.spec === spec);
      expect(imp, `${src} uses ${spec}`).toBeDefined();
      expect(resolver.resolve(file, imp!)).toEqual([]);
    }
  });

  it('gives the files of one namespace a shared scope key', () => {
    const scopes = (path: string) => resolver.scopes!(index.get(path)!);
    for (const [a, b] of expected.sameNamespace) {
      expect(scopes(a).length, a).toBeGreaterThan(0);
      expect(scopes(a), `${a} ~ ${b}`).toEqual(scopes(b));
    }
    expect(scopes('src/Models/Order.php')).toEqual(['php:App\\Models']);
    expect(scopes('src/Models/Order.php')).not.toEqual(scopes('src/Services/OrderService.php'));
    expect(scopes('public/index.php')).toEqual([]);
  });
});

describe('php scanner', () => {
  it('does not take a trait use or a closure use for an import', () => {
    expect(scanPhp(files['src/Models/Order.php'])).toEqual({
      imports: [{ spec: 'App\\Support\\money', kind: 'use', names: ['money'] }],
      decls: { namespace: ['App\\Models'], classes: ['Order'] },
    });
    const { imports, decls } = scanPhp([
      `<?php`,
      `namespace App;`,
      `use App\\Contracts\\Shape;`,
      `$area = function (Shape $s) use ($scale) { return $s->area() * $scale; };`,
      `final class Circle implements Shape {`,
      `    use Scales, \\App\\Concerns\\Draws { Scales::resize as protected; }`,
      `    public function use(callable $fn) { return static function () use ($fn) { return $fn(); }; }`,
      `}`,
      `function area(Shape $s) { return $s->area(); }`,
    ].join('\n'));
    expect(imports).toEqual([{ spec: 'App\\Contracts\\Shape', kind: 'use', names: ['Shape'] }]);
    expect(decls).toEqual({ namespace: ['App'], classes: ['Circle'], functions: ['area'] });
  });

  it('reads grouped uses, aliases, and function and const imports', () => {
    const { imports } = scanPhp([
      `<?php`,
      `use App\\Models\\{User, Order as Purchase, Billing\\Invoice};`,
      `use App\\Http\\Request as HttpRequest, \\App\\Http\\Response;`,
      `use function App\\Support\\{money, tax as vat};`,
      `use const App\\Support\\CURRENCY;`,
    ].join('\n'));
    expect(imports.map((i) => `${i.spec} as ${i.names![0]}`)).toEqual([
      'App\\Models\\User as User',
      'App\\Models\\Order as Purchase',
      'App\\Models\\Billing\\Invoice as Invoice',
      'App\\Http\\Request as HttpRequest',
      'App\\Http\\Response as Response',
      'App\\Support\\money as money',
      'App\\Support\\tax as vat',
      'App\\Support\\CURRENCY as CURRENCY',
    ]);
    expect(imports.every((i) => i.kind === 'use')).toBe(true);
  });

  it('ignores heredocs, strings, comments and the HTML around the PHP', () => {
    const { imports, decls } = scanPhp([
      `<p>use Html\\Text; it's not PHP: class Fake {}</p>`,
      `<?php`,
      `// use In\\LineComment;`,
      `# use In\\HashComment;`,
      `/* use In\\BlockComment; */`,
      `$a = 'use In\\\\SingleQuotes; \\' class A {}';`,
      `$b = "use In\\\\DoubleQuotes; {$a} \\" require 'x.php';";`,
      `$c = <<<EOT`,
      `use In\\Heredoc;`,
      `  EOTX is not the end`,
      `require 'in/heredoc.php';`,
      `  EOT;`,
      `$d = <<<'EOT'`,
      `use In\\Nowdoc;`,
      `EOT;`,
      `use Real\\Thing; ?>`,
      `<b>use Html\\Again; class Fake2 {}</b>`,
      `<?= $c ?>`,
      `<?php use Real\\Other;`,
    ].join('\n'));
    expect(imports.map((i) => i.spec)).toEqual(['Real\\Thing', 'Real\\Other']);
    expect(decls).toBeUndefined();
  });

  it('reads literal include paths and skips computed ones', () => {
    const { imports } = scanPhp([
      `<?php`,
      `require_once __DIR__ . '/../bootstrap/app.php';`,
      `require __DIR__ . '/config.php';`,
      `include_once dirname(__FILE__) . "/lib/util.php";`,
      `include(dirname(__DIR__, 2) . '/vendor/autoload.php');`,
      `require dirname(dirname(__FILE__)) . '/up.php';`,
      `require_once('legacy/db.php');`,
      `if ($debug) { include 'debug.php'; }`,
      `require $path;`,
      `require __DIR__ . '/' . $name . '.php';`,
      `require "views/$name.php";`,
      `require ROOT . '/const.php';`,
      `require '/etc/absolute.php';`,
      `$this->include('not/a/statement.php');`,
    ].join('\n'));
    expect(imports).toEqual([
      { spec: '../bootstrap/app.php', kind: 'require' },
      { spec: './config.php', kind: 'require' },
      { spec: './lib/util.php', kind: 'require' },
      { spec: '../../vendor/autoload.php', kind: 'require' },
      { spec: '../up.php', kind: 'require' },
      { spec: 'legacy/db.php', kind: 'require' },
      { spec: 'debug.php', kind: 'require' },
    ]);
  });
});

describe('php resolver', () => {
  const file = (path: string, text = ''): FileFacts =>
    path.endsWith('.json')
      ? { path, oid: '', bytes: 0, lang: null, loc: 1, imports: [], excerpt: text }
      : { path, oid: '', bytes: 0, lang: 'php', loc: 1, ...scanPhp(text) };

  it('prefers the longest PSR-4 prefix and falls back to declared names', () => {
    const repo = createRepoIndex([
      file('composer.json', JSON.stringify({ autoload: { 'psr-4': { 'Acme\\': 'src/', 'Acme\\Plugin\\': ['plugins/core/', 'plugins/extra'] }, 'psr-0': { Legacy_: 'old/' } } })),
      file('src/Mailer.php'),
      file('src/Plugin/Hook.php'),
      file('plugins/extra/Hook.php'),
      file('old/Legacy/Db/Table.php'),
      file('lib/strings.php', `<?php namespace Acme\\Util; class Str {} function slug() {}`),
      file('app/main.php'),
    ]);
    const r = createPhpResolver(repo);
    const to = (spec: string) => r.resolve(repo.get('app/main.php')!, { spec, kind: 'use' });
    expect(to('Acme\\Mailer')).toEqual([{ path: 'src/Mailer.php', confidence: 1 }]);
    expect(to('Acme\\Plugin\\Hook')).toEqual([{ path: 'plugins/extra/Hook.php', confidence: 1 }]);
    expect(to('Legacy_Db_Table')).toEqual([{ path: 'old/Legacy/Db/Table.php', confidence: 1 }]);
    expect(to('Acme\\Util\\Str')).toEqual([{ path: 'lib/strings.php', confidence: 1 }]);
    expect(to('Acme\\Util\\slug')).toEqual([{ path: 'lib/strings.php', confidence: 1 }]);
    expect(to('Acme\\Missing')).toEqual([]);
    expect(to('Symfony\\Component\\Console\\Command')).toEqual([]);
  });

  it('resolves include paths from the including file and rejects escapes', () => {
    const repo = createRepoIndex(['index.php', 'inc/db.php', 'admin/pages/users.php', 'admin/pages/menu.php'].map((p) => file(p)));
    const r = createPhpResolver(repo);
    const to = (spec: string) => r.resolve(repo.get('admin/pages/users.php')!, { spec, kind: 'require' }).map((h) => h.path);
    expect(to('./menu.php')).toEqual(['admin/pages/menu.php']);
    expect(to('../../inc/db.php')).toEqual(['inc/db.php']);
    expect(to('inc/db.php')).toEqual(['inc/db.php']);
    expect(to('./db.php')).toEqual([]);
    expect(to('../../../index.php')).toEqual([]);
    expect(to('./users.php')).toEqual([]);
  });
});

describe('php syntax query', () => {
  /** Captures of one file as "kind name" lines; a name is paired with the kind capture before it. */
  const symbols = async (path: string): Promise<string[]> => {
    const out: string[] = [];
    let kind = '';
    for (const c of await runQuery('php', PHP_QUERY, files[path])) {
      if (c.capture === 'name') out.push(`${kind} ${c.text}`);
      else if (c.capture !== 'qualifier' && c.capture !== 'container') kind = c.capture;
    }
    return out;
  };

  it('has a grammar and captures definitions, calls, types and inheritance', async () => {
    expect(php.syntax!.grammar('src/Services/OrderService.php')).toBe('php');
    expect(grammarPath('php')).not.toBeNull();

    const captures = await runQuery('php', PHP_QUERY, files['src/Services/OrderService.php']);
    const texts = (capture: string) => captures.filter((c) => c.capture === capture).map((c) => c.text);
    expect(texts('container')).toEqual(['OrderService', 'OrderService']);
    expect(texts('qualifier')).toEqual(['Order']);

    const service = await symbols('src/Services/OrderService.php');
    expect(service).toEqual(expect.arrayContaining([
      'definition.class OrderService',
      'definition.method __construct',
      'definition.method place',
      'reference.call create',
      'reference.call charge',
      'reference.call total',
      'reference.type PaymentGateway',
      'reference.type Buyer',
      'reference.type Order',
      'reference.type RuntimeException',
    ]));

    expect(await symbols('src/Models/Order.php')).toEqual(expect.arrayContaining([
      'reference.inherit HasTimestamps',
      'reference.call money',
      'reference.type Customer',
    ]));
    expect(await symbols('src/Http/Controllers/OrderController.php')).toContain('reference.inherit Controller');
    expect(await symbols('tests/Fakes/FakeGateway.php')).toContain('reference.inherit PaymentGateway');
    expect(await symbols('src/Services/PaymentGateway.php')).toEqual(['definition.interface PaymentGateway', 'definition.method charge']);
    expect(await symbols('src/Support/helpers.php')).toContain('definition.function money');
  });

  it('finds each expected call at its call site and its definition in the target file', async () => {
    for (const [src, dst, symbol] of expected.calls) {
      expect(await symbols(src), `${src} calls ${symbol}`).toContain(`reference.call ${symbol}`);
      const defs = (await symbols(dst)).filter((s) => s.startsWith('definition.')).map((s) => s.split(' ')[1]);
      expect(defs, `${dst} defines ${symbol}`).toContain(symbol);
    }
  });
});
