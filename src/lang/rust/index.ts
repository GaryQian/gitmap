// Rust plug-in: a fast-pass scanner for `mod`, `use` and `extern crate`, a resolver that follows the
// module tree from the crate roots named by Cargo.toml, and a tree-sitter query for the slow pass.
//
// No `scopes`: a crate is not a scope in the linker's sense. An item of another module is reached
// through a `use` or a qualified path, never by its bare name, so a crate-wide key would link every
// `new` or `Error` in a crate to every other. Qualified paths written without a `use`
// (`crate::a::f()`, `super::T`) are reported by the scanner as imports of kind 'path' instead, which
// gives the linker an exact edge to the module they name.
import { config } from '../../config';
import type { LanguagePlugin } from '../../contracts/lang';
import { languageColor } from '../../shared';
import { RUST_QUERY } from './queries';
import { createRustResolver } from './resolve';
import { scanRust } from './scan';

export { scanRust } from './scan';
export { createRustResolver } from './resolve';
export { RUST_QUERY } from './queries';
export { parseToml } from './cargo';

const rust: LanguagePlugin = {
  id: 'rust',
  name: 'Rust',
  extensions: ['rs'],
  color: languageColor('rust', config.visual),
  manifests: ['Cargo.toml'],
  scan: (text) => scanRust(text),
  syntax: { grammar: () => 'rust', queries: { rust: RUST_QUERY } },
  createResolver: createRustResolver,
};

export default rust;
