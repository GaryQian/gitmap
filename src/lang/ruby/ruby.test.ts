import { describe, expect, it } from 'vitest';
import type { FileFacts, ResolvedImport } from '../../contracts/lang';
import { createRepoIndex } from '../../shared/repoIndex';
import { fixtureExpected, fixtureFiles } from '../../testing/fixture';
import { grammarPath, runQuery } from '../../testing/treesitter';
import ruby, { createRubyResolver, scanRuby } from './index';

interface Expected { imports: [string, string][]; notImports: [string, string][]; calls: [string, string, string][] }

const facts = (path: string, text = ''): FileFacts => ({ path, oid: '', bytes: text.length, lang: 'ruby', loc: 1, ...scanRuby(text) });
const specs = (text: string) => scanRuby(text).imports.map((i) => `${i.kind}:${i.spec}`);

describe('ruby fixture', () => {
  const files = fixtureFiles('ruby');
  const expected = fixtureExpected<Expected>('ruby');
  const index = createRepoIndex(Object.entries(files).map(([path, text]) => facts(path, text)));
  const resolver = createRubyResolver(index);
  /** Every resolved import of the fixture as 'src -> dst' → the best confidence of that edge. */
  const edges = new Map<string, number>();
  const resolved = new Map<string, ResolvedImport[]>();
  for (const file of index.files) {
    for (const imp of file.imports) {
      const hits = resolver.resolve(file, imp);
      resolved.set(`${file.path} ${imp.kind}:${imp.spec}`, hits);
      for (const hit of hits) {
        const key = `${file.path} -> ${hit.path}`;
        edges.set(key, Math.max(edges.get(key) ?? 0, hit.confidence));
      }
    }
  }

  it('resolves every expected import and none of the forbidden ones', () => {
    expect(expected.imports.length).toBeGreaterThan(10);
    for (const [src, dst] of expected.imports) expect(edges.has(`${src} -> ${dst}`), `${src} -> ${dst}`).toBe(true);
    for (const [src, dst] of expected.notImports) expect(edges.has(`${src} -> ${dst}`), `${src} -/-> ${dst}`).toBe(false);
    // Nothing links to itself, and nothing outside the expected list appears: the fixture is small enough to list in full.
    expect([...edges.keys()].sort()).toEqual(expected.imports.map(([src, dst]) => `${src} -> ${dst}`).sort());
  });

  it('leaves stdlib requires and gem constants unresolved', () => {
    for (const key of [
      'lib/mygem.rb require:json', 'lib/mygem.rb const:JSON', 'lib/mygem.rb const:JSON::ParserError',
      'lib/mygem/client.rb require:net/http', 'lib/mygem/transport/http.rb const:Net::HTTP',
      'app/controllers/application_controller.rb const:ActionController::Base',
      'app/models/user.rb const:ApplicationRecord', 'app/models/concerns/trackable.rb const:ActiveSupport::Concern',
      'mygem.gemspec const:Gem::Specification',
    ]) expect(resolved.get(key), key).toEqual([]);
  });

  it('ranks a written require above a defined constant above a naming-convention match', () => {
    const written = edges.get('lib/mygem/transport/http.rb -> lib/mygem/version.rb')!;        // require_relative
    const defined = edges.get('app/controllers/users_controller.rb -> app/models/user.rb')!;  // `class User` found in the index
    const byName = edges.get('app/controllers/users_controller.rb -> app/models/legacy_account.rb')!; // no definition in sight
    expect(written).toBe(1);
    expect(defined).toBeLessThan(written);
    expect(byName).toBeLessThan(defined);
    expect(byName).toBeGreaterThan(0);
  });

  it('compiles the query and captures definitions and references', async () => {
    expect(grammarPath('ruby')).not.toBeNull();
    expect(ruby.syntax!.grammar('lib/tasks/report.rake')).toBe('ruby');
    const query = ruby.syntax!.queries.ruby;
    const user = await runQuery('ruby', query, files['app/models/user.rb']);
    const texts = (caps: typeof user, capture: string) => caps.filter((c) => c.capture === capture).map((c) => c.text);
    // The whole definition node is captured, so compare by its first line.
    const heads = (caps: typeof user, capture: string) => texts(caps, capture).map((t) => t.split('\n')[0]);
    expect(heads(user, 'definition.class')).toEqual(['class User < ApplicationRecord']);
    expect(heads(user, 'definition.method')).toEqual(['def self.active', 'def admin?']);
    expect(heads(user, 'definition.constant')).toEqual(['ROLES = %w[member admin].freeze']);
    expect(texts(user, 'container')).toEqual(['User', 'User', 'User']);
    expect(heads(user, 'reference.inherit')).toEqual(['< ApplicationRecord', 'include Trackable']);
    expect(texts(user, 'name')).toEqual(expect.arrayContaining(['User', 'active', 'admin?', 'ROLES', 'ApplicationRecord', 'Trackable', 'validates', 'where']));

    const client = await runQuery('ruby', query, files['lib/mygem/client.rb']);
    expect(heads(client, 'definition.module')).toEqual(['module Mygem']);
    expect(heads(client, 'definition.method')).toEqual(['def initialize(token, host: DEFAULT_HOST)', 'def account(id)', 'def user_agent']);
    expect(texts(client, 'container')).toEqual(expect.arrayContaining(['Mygem', 'Client']));
    expect(texts(client, 'qualifier')).toEqual(['Http', 'Formatter', 'Mygem']); // Transport::Http.new, Formatter.new, Mygem.parse
    expect(texts(client, 'reference.call')).toEqual(expect.arrayContaining(['Transport::Http.new(host, token)', '@transport.get("/accounts/#{id}")']));
    expect(texts(client, 'reference.type')).toEqual(expect.arrayContaining(['Transport', 'Http', 'Formatter', 'VERSION']));

    // Each expected call is at least visible to the linker: referenced by name in src, defined by name in dst.
    for (const [src, dst, symbol] of expected.calls) {
      const refs = await runQuery('ruby', query, files[src]);
      const defs = await runQuery('ruby', query, files[dst]);
      const called = refs.some((c) => c.capture === 'reference.call' && c.text.includes(`.${symbol}`)) && refs.some((c) => c.capture === 'name' && c.text === symbol);
      const defined = defs.some((c) => c.capture === 'definition.method' && (c.text.startsWith(`def ${symbol}`) || c.text.startsWith(`def self.${symbol}`)));
      expect(called, `${src} calls ${symbol}`).toBe(true);
      expect(defined, `${dst} defines ${symbol}`).toBe(true);
    }
  });
});

describe('ruby scanner', () => {
  it('reads requires with literal arguments only', () => {
    expect(scanRuby([
      `require 'set'`,
      `require("a/b")`,
      `require_relative '../c'`,
      `load 'tasks/d.rake'`,
      `autoload :Widget, 'e/widget'`,
      `require "x/#{name}"`,
      `require File.expand_path('../y', __FILE__)`,
      `Bundler.require(:default)`,
      `gem 'rails', require: false`,
      `params.require 'user'`,
    ].join('\n')).imports).toEqual([
      { spec: 'set', kind: 'require' },
      { spec: 'a/b', kind: 'require' },
      { spec: '../c', kind: 'require_relative' },
      { spec: 'tasks/d.rake', kind: 'load' },
      { spec: 'e/widget', kind: 'autoload', names: ['Widget'] },
      { spec: 'Bundler', kind: 'const' },
    ]);
  });

  it('stays out of comments, strings, heredocs, regex and % literals, and stops at __END__', () => {
    expect(specs([
      `# require 'in_comment' and InComment`,
      `=begin`,
      `require 'in_block_comment'`,
      `=end`,
      `a = "require 'in_string' InString #{InInterpolation} it's"`,
      `b = 'require "in_single" InSingle'`,
      `c = <<~RUBY + <<-'SQL'`,
      `  require 'in_heredoc'`,
      `  InHeredoc.call("unbalanced)`,
      `RUBY`,
      `  SELECT 'InSecondHeredoc'`,
      `  SQL`,
      `d = %w[InWords it's] + %q(InQ 'x) + [%i[a b]]`,
      `e = line =~ /InRegex's "/ ? Real::Thing : nil`,
      `f = total / count / Divisor`,
      `g = x ? ?' : $'`,
      `list << Appended`,
      `require 'real'`,
      `__END__`,
      `require 'after_end'`,
      `AfterEnd`,
    ].join('\n'))).toEqual(['require:real', 'const:Real::Thing', 'const:Divisor', 'const:Appended']);
  });

  it('builds qualified names from the nesting and leaves out what the file defines', () => {
    const { imports, decls } = scanRuby([
      `module A`,
      `  class B < Base`,
      `    include Helpers::Naming`,
      `    LIMIT = 3`,
      `    Point = Struct.new(:x, :y)`,
      `    class << self`,
      `      def build(kind: Default) = new`,
      `    end`,
      `    class Inner; end`,
      `    def call(other)`,
      `      if other.is_a?(B) && other.class == A::B`,
      `        Inner.new(LIMIT, ::Top, other.class::DYNAMIC, Integer('3'), Sibling)`,
      `      end`,
      `    end`,
      `  end`,
      `  class Sibling`,
      `  end`,
      `end`,
      `class A::C::D < A::B`,
      `end`,
      `After = A::Missing`,
    ].join('\n'));
    expect(decls).toEqual({
      classes: ['A', 'A::B', 'A::B::Inner', 'A::Sibling', 'A::C::D'],
      constants: ['A::B::LIMIT', 'A::B::Point', 'After'],
    });
    expect(imports.map((i) => i.spec)).toEqual(['Base', 'Helpers::Naming', 'Default', '::Top', 'A::Missing']);
    expect(imports.every((i) => i.kind === 'const')).toBe(true);
  });

  it('never throws and keeps the reference count bounded', () => {
    for (const text of ['', '"', "'", '<<~X', '%w[', 'x = /', 'class', 'module ', 'def ', 'a = <<', '=begin', '"#{"#{"#{', '﻿require "bom"']) {
      expect(() => scanRuby(text)).not.toThrow();
    }
    expect(specs('﻿require "bom"')).toEqual(['require:bom']);
    const many = Array.from({ length: 500 }, (_, k) => `Const${k}.call`).join('\n');
    expect(scanRuby(many).imports.length).toBeLessThan(200);
  });
});

describe('ruby resolver', () => {
  const index = createRepoIndex([
    facts('Rakefile'),
    facts('lib/shop.rb', 'module Shop\nend'),
    facts('lib/shop/cart.rb', 'module Shop\n  class Cart\n  end\nend'),
    facts('lib/shop/config.rb', 'module Shop\n  class Settings\n  end\nend'),
    facts('gems/pay/lib/pay.rb', 'module Pay\nend'),
    facts('gems/pay/lib/pay/util.rb'),
    facts('gems/ship/lib/ship.rb'),
    facts('gems/ship/lib/pay/util.rb'),
    facts('gems/ship/lib/ship/json.rb'),
    facts('spec/spec_helper.rb'),
    facts('spec/cart_spec.rb'),
    facts('app/models/order.rb'),
    facts('app/services/billing/http_client.rb'),
    facts('app/controllers/orders_controller.rb'),
    facts('app/controllers/api/orders_controller.rb'),
    facts('app/controllers/api/base_controller.rb'),
  ]);
  const resolver = createRubyResolver(index);
  const resolve = (from: string, kind: string, spec: string) => resolver.resolve(index.get(from)!, { spec, kind });

  it('resolves requires against the load paths found in the repo', () => {
    expect(resolve('spec/cart_spec.rb', 'require', 'shop/cart')).toEqual([{ path: 'lib/shop/cart.rb', confidence: 1 }]);
    expect(resolve('spec/cart_spec.rb', 'require', 'spec_helper')).toEqual([{ path: 'spec/spec_helper.rb', confidence: 1 }]);
    expect(resolve('lib/shop.rb', 'require', 'order')).toEqual([{ path: 'app/models/order.rb', confidence: 1 }]);
    expect(resolve('Rakefile', 'require_relative', 'lib/shop')).toEqual([{ path: 'lib/shop.rb', confidence: 1 }]);
    expect(resolve('lib/shop/cart.rb', 'require_relative', '../shop.rb')).toEqual([{ path: 'lib/shop.rb', confidence: 1 }]);
    expect(resolve('Rakefile', 'load', 'gems/pay/lib/pay.rb')).toEqual([{ path: 'gems/pay/lib/pay.rb', confidence: 1 }]);
    // Two gems ship pay/util.rb: the one in the requiring file's own lib/ wins, with less than full confidence.
    const own = resolve('gems/ship/lib/ship.rb', 'require', 'pay/util');
    expect(own.map((r) => r.path)).toEqual(['gems/ship/lib/pay/util.rb']);
    expect(own[0].confidence).toBeLessThan(1);
    // gems/ship/lib/ship/json.rb is not at a load-path root, so `require 'json'` is the stdlib.
    expect(resolve('gems/ship/lib/ship.rb', 'require', 'json')).toEqual([]);
    expect(resolve('lib/shop.rb', 'require', 'active_support/all')).toEqual([]);
    expect(resolve('lib/shop.rb', 'require_relative', '../../outside')).toEqual([]);
  });

  it('links constants through defined names first, then the naming convention, then the nearest directory', () => {
    const defined = resolve('spec/cart_spec.rb', 'const', 'Shop::Cart');
    expect(defined.map((r) => r.path)).toEqual(['lib/shop/cart.rb']);
    // `Shop` is reopened by cart.rb too; the file named after it is its home.
    expect(resolve('spec/cart_spec.rb', 'const', 'Shop')).toEqual([{ path: 'lib/shop.rb', confidence: defined[0].confidence }]);
    // No scanned definition: only the path says where these live. Acronyms underscore as written.
    const byName = resolve('app/models/order.rb', 'const', 'Billing::HTTPClient');
    expect(byName.map((r) => r.path)).toEqual(['app/services/billing/http_client.rb']);
    expect(byName[0].confidence).toBeLessThan(defined[0].confidence);
    expect(resolve('app/models/order.rb', 'const', 'Api::OrdersController').map((r) => r.path)).toEqual(['app/controllers/api/orders_controller.rb']);
    expect(resolve('app/models/order.rb', 'const', 'Order::STATES')).toEqual([]); // its own file
    expect(resolve('spec/cart_spec.rb', 'const', 'Order::STATES').map((r) => r.path)).toEqual(['app/models/order.rb']);
    // Two files end in orders_controller.rb: the one beside the referring file, at the lowest confidence.
    const near = resolve('app/controllers/api/base_controller.rb', 'const', 'OrdersController');
    expect(near.map((r) => r.path)).toEqual(['app/controllers/api/orders_controller.rb']);
    expect(near[0].confidence).toBeLessThan(byName[0].confidence);
    // `Cart` is not in scope outside Shop, but cart.rb is the one file named for it and does define a Cart.
    expect(resolve('app/models/order.rb', 'const', 'Cart')).toEqual([{ path: 'lib/shop/cart.rb', confidence: byName[0].confidence }]);
    // A file whose scanned definitions say otherwise is not a match for its name.
    expect(resolve('app/models/order.rb', 'const', 'Config')).toEqual([]);
    expect(resolve('app/models/order.rb', 'const', 'ActiveRecord::Base')).toEqual([]);
  });
});
