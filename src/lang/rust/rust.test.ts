import { describe, expect, it } from 'vitest';
import { Parser, Query } from 'web-tree-sitter';
import type { FileFacts } from '../../contracts/lang';
import { createRepoIndex } from '../../shared/repoIndex';
import { fixtureExpected, fixtureFiles } from '../../testing/fixture';
import { grammarPath, loadGrammar, runQuery } from '../../testing/treesitter';
import rust, { parseToml, scanRust } from './index';

/** Fast-pass facts for a set of files, as the pipeline would hand them to the resolver. */
function facts(files: Record<string, string>): FileFacts[] {
  return Object.keys(files).sort().map((path) => {
    const text = files[path];
    const base = { path, oid: '', bytes: text.length, loc: 1 };
    if (path.endsWith('.rs')) return { ...base, lang: 'rust', ...scanRust(text) };
    return { ...base, lang: null, imports: [], ...(path.endsWith('Cargo.toml') ? { excerpt: text } : {}) };
  });
}
/** Every resolved import as 'src -> dst'. */
function edges(files: Record<string, string>): Set<string> {
  const index = createRepoIndex(facts(files));
  const resolver = rust.createResolver!(index);
  const out = new Set<string>();
  for (const file of index.byLang('rust')) {
    for (const imp of file.imports) for (const hit of resolver.resolve(file, imp)) out.add(`${file.path} -> ${hit.path}`);
  }
  return out;
}

describe('rust scanner', () => {
  it('flattens use-trees, including multi-line ones with comments', () => {
    const { imports } = scanRust([
      `mod parser;`,
      `pub(crate) mod util;`,
      `extern crate alloc;`,
      `use std::collections::HashMap;`,
      `pub use crate::model::{`,
      `    Node, // a comment between names`,
      `    edge::{self, Edge as E},`,
      `    graph::*,`,
      `};`,
      `use super::helpers as h;`,
      `use serde;`,
      `fn f<'a>(x: &'a str) -> impl Iterator<Item = &'a str> + use<'a> { x.split(',') }`,
    ].join('\n'));
    expect(imports).toEqual([
      { spec: 'parser', kind: 'mod' },
      { spec: 'util', kind: 'mod' },
      { spec: 'alloc', kind: 'extern-crate' },
      { spec: 'std::collections', kind: 'use', names: ['HashMap'] },
      { spec: 'crate::model', kind: 'use', names: ['Node', 'edge'] },
      { spec: 'crate::model::edge', kind: 'use', names: ['Edge'] },
      { spec: 'crate::model::graph', kind: 'use', names: ['*'] },
      { spec: 'super', kind: 'use', names: ['helpers'] },
      { spec: 'serde', kind: 'use' },
    ]);
  });

  it('skips comments (nested), strings, raw strings and char literals, but not lifetimes', () => {
    const text = [
      `/* use a::in_comment; /* nested: mod b; */ still a comment: use c::d; */`,
      `// use e::line_comment;`,
      `const S: &str = "use f::in_string; \\" mod g;";`,
      `const R: &str = r#"use h::in_raw_string; " mod i;"#;`,
      `const Q: char = '"'; const B: u8 = b'\\''; const N: char = '\\n';`,
      `struct Holder<'a> { text: &'a str }`,
      `impl<'a> Holder<'a> { fn get(&self) -> &'a str { 'outer: loop { break 'outer; } self.text } }`,
      `use real::Thing;`,
    ].join('\n');
    expect(scanRust(text).imports).toEqual([{ spec: 'real', kind: 'use', names: ['Thing'] }]);
  });

  it('reports paths inside inline modules relative to the file, and qualified paths without a use', () => {
    const scan = scanRust([
      `#[cfg(unix)] #[path = "sys/unix.rs"] mod sys;`,
      `mod inner {`,
      `    mod deep;`,
      `    use super::Config;`,
      `    use super::super::sibling::Thing;`,
      `    use self::deep::Leaf;`,
      `}`,
      `pub(in crate::app) fn run() { crate::log::info("x"); crate::log::warn("y"); super::setup(); }`,
      `#[cfg(test)]`,
      `mod tests { use super::*; }`,
    ].join('\n'));
    expect(scan.imports).toEqual([
      { spec: 'sys', kind: 'mod' },
      { spec: 'inner::deep', kind: 'mod' },
      { spec: 'self', kind: 'use', names: ['Config'] },
      { spec: 'super::sibling', kind: 'use', names: ['Thing'] },
      { spec: 'self::inner::deep', kind: 'use', names: ['Leaf'] },
      { spec: 'self', kind: 'use', names: ['*'] },
      { spec: 'crate::log', kind: 'path', names: ['info', 'warn'] },
      { spec: 'super', kind: 'path', names: ['setup'] },
    ]);
    expect(scan.decls).toEqual({ mod: ['inner', 'tests'], modPath: ['sys=sys/unix.rs'] });
  });

  it('never throws on malformed input', () => {
    for (const text of ['use', 'use a::{', 'use a::{b, c::{', 'mod', 'mod x', 'extern crate', "'", '"unterminated use a;', 'r###"', '/* /* use a;', 'use ::;', '}}} mod a { use super::super::x;']) {
      expect(() => scanRust(text)).not.toThrow();
    }
  });
});

describe('rust resolver', () => {
  it('resolves the fixture workspace: every expected import, none of the forbidden ones', () => {
    const expected = fixtureExpected<{ imports: [string, string][]; notImports: [string, string][] }>('rust');
    const found = edges(fixtureFiles('rust'));
    for (const [src, dst] of expected.imports) expect(found, `${src} -> ${dst}`).toContain(`${src} -> ${dst}`);
    for (const [src, dst] of expected.notImports) expect(found, `${src} -> ${dst}`).not.toContain(`${src} -> ${dst}`);
  });

  it('follows #[path], renamed dependencies, 2015-edition paths and stray test targets', () => {
    const found = edges({
      'Cargo.toml': `[package]\nname = "app"\nedition = "2021"\n[dependencies]\nstore = { package = "kv-store", path = "kv" }\nrand = "0.8"\n`,
      'src/main.rs': `#[cfg_attr(unix, path = "os/unix.rs")]\n#[cfg_attr(windows, path = "os/windows.rs")]\nmod os;\nuse store::Table;\nuse rand::Rng;\nuse os::open;\n`,
      'src/os/unix.rs': `use super::missing::Thing;\n`,
      'src/os/windows.rs': ``,
      'tests/smoke.rs': `mod common;\nuse app::anything;\n`,
      'tests/common/mod.rs': `use std::env;\n`,
      'kv/Cargo.toml': `[package]\nname = "kv-store" # no edition: 2015\n[lib]\nname = "kv_store"\npath = "lib/root.rs"\n`,
      'kv/lib/root.rs': `mod table;\nmod codec;\npub use table::Table;\n`,
      'kv/lib/table.rs': `use codec::encode;\n`,
      'kv/lib/codec.rs': ``,
    });
    expect([...found].sort()).toEqual([
      'kv/lib/root.rs -> kv/lib/codec.rs',
      'kv/lib/root.rs -> kv/lib/table.rs',
      'kv/lib/table.rs -> kv/lib/codec.rs',
      'src/main.rs -> kv/lib/table.rs',
      'src/main.rs -> src/os/unix.rs',
      'src/main.rs -> src/os/windows.rs',
      'src/os/unix.rs -> src/main.rs',
      'tests/smoke.rs -> tests/common/mod.rs',
    ]);
  });

  it('reads the Cargo.toml subset it needs', () => {
    const toml = parseToml(`# comment\n[package]\nname = "a-b" # trailing\nedition.workspace = true\n[[bin]]\nname = 'x'\npath = "src/x.rs"\n[[bin]]\nname = "y"\n[dependencies]\nserde = { version = "1", features = [\n  "derive", # why\n] }\n[target.'cfg(unix)'.dependencies]\nlibc = "0.2"\nnot valid toml here\nlast = 1\n`);
    expect(JSON.parse(JSON.stringify(toml))).toEqual({
      package: { name: 'a-b', edition: { workspace: true } },
      bin: [{ name: 'x', path: 'src/x.rs' }, { name: 'y' }],
      dependencies: { serde: { version: '1', features: ['derive'] } },
      target: { 'cfg(unix)': { dependencies: { libc: '0.2', last: '1' } } },
    });
  });
});

/** One line per query match: 'definition.method Body.new', 'reference.call step.advance', 'reference.type Mass'. */
async function matches(text: string): Promise<string[]> {
  const lang = await loadGrammar('rust');
  const parser = new Parser();
  parser.setLanguage(lang);
  const tree = parser.parse(text)!;
  const query = new Query(lang, rust.syntax!.queries.rust);
  try {
    return query.matches(tree.rootNode).map((m) => {
      const text = (name: string) => m.captures.find((c) => c.name === name)?.node.text;
      const kinds = m.captures.filter((c) => c.name.startsWith('definition.') || c.name.startsWith('reference.'));
      const scope = text('container') ?? text('qualifier');
      return `${kinds.map((k) => k.name).join('+')} ${scope ? `${scope}.` : ''}${text('name')}`;
    });
  } finally {
    query.delete();
    tree.delete();
    parser.delete();
  }
}

describe('rust slow-pass query', () => {
  it('compiles and captures definitions, calls and implemented traits', async () => {
    expect(grammarPath('rust')).not.toBeNull();
    expect(rust.syntax!.grammar('src/lib.rs')).toBe('rust');
    const files = fixtureFiles('rust');
    const of = (all: string[], kind: string) => all.filter((m) => m.startsWith(`${kind} `)).map((m) => m.slice(kind.length + 1));

    const lib = await runQuery('rust', rust.syntax!.queries.rust, files['crates/engine/src/lib.rs']);
    expect(lib.filter((c) => c.capture.startsWith('definition.')).map((c) => c.capture)).toEqual(
      ['definition.function', 'definition.enum', 'definition.method'],
    );

    const body = await matches(files['crates/engine/src/body.rs']);
    expect(of(body, 'definition.struct')).toEqual(['Body']);
    expect(of(body, 'definition.method')).toEqual(['Body.new', 'Body.distance_to', 'Body.is_finite', 'Body.fmt']);
    expect(of(body, 'definition.function')).toEqual([]);
    expect(of(body, 'reference.inherit')).toEqual(['Display']);
    expect(of(body, 'reference.call')).toEqual(expect.arrayContaining(['metres', 'Length.from_metres', 'hypot', 'write']));
    expect(of(body, 'reference.type')).toEqual(expect.arrayContaining(['Mass', 'Length']));

    const integrator = await matches(files['crates/engine/src/physics/integrator.rs']);
    expect(of(integrator, 'definition.function')).toEqual(['simulate', 'net_forces']);
    const calls = of(integrator, 'reference.call');
    expect(calls).toEqual(expect.arrayContaining(['validate', 'net_forces', 'step.advance', 'attraction', 'Vec.with_capacity']));
    // one match per call site: no two patterns claim the same call
    expect(calls.filter((c) => c.endsWith('advance'))).toHaveLength(1);
    expect(calls.filter((c) => c === 'attraction')).toHaveLength(1);
    expect(calls.filter((c) => c.endsWith('validate'))).toHaveLength(1);
  });
});
