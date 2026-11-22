// TypeScript and JavaScript plug-ins. They share the scanner and one resolver: a .js file can import
// a .ts file and the other way round. The slow-pass queries (tree-sitter) are in ./queries.ts.
import { config } from '../../config';
import type { LanguagePlugin } from '../../contracts/lang';
import { languageColor } from '../../shared';
import { jsSyntax, tsSyntax } from './queries';
import { tsResolver } from './resolve';
import { scanImports } from './scan';

export { scanImports } from './scan';
export { tsResolver } from './resolve';
export { parseJsonc } from './jsonc';

/** Config files whose text the resolver reads. `extends` chains are followed into any of these. */
const MANIFESTS = ['tsconfig.json', 'jsconfig.json', 'package.json', 'tsconfig.base.json', 'tsconfig.app.json', 'tsconfig.build.json', 'tsconfig.lib.json'];

const ts: LanguagePlugin = {
  id: 'ts',
  name: 'TypeScript',
  extensions: ['ts', 'tsx', 'mts', 'cts'],
  color: languageColor('ts', config.visual),
  manifests: MANIFESTS,
  scan: (text) => scanImports(text),
  syntax: tsSyntax,
  createResolver: tsResolver,
};

const js: LanguagePlugin = {
  id: 'js',
  name: 'JavaScript',
  extensions: ['js', 'jsx', 'mjs', 'cjs'],
  color: languageColor('js', config.visual),
  manifests: MANIFESTS,
  scan: (text) => scanImports(text),
  syntax: jsSyntax,
  createResolver: tsResolver,
};

export default [ts, js];
