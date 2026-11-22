// Swift plug-in: a scanner for imports and top-level type names, a resolver that works out modules
// (Package.swift targets, or folders) and offers them as scopes, and a tree-sitter query for the
// slow pass. Swift files see their module's other files without importing them, so most of the
// structure comes from the scopes and the symbol linker rather than from import edges.
import { config } from '../../config';
import type { LanguagePlugin } from '../../contracts/lang';
import { languageColor } from '../../shared';
import { SWIFT_QUERY } from './queries';
import { createSwiftResolver } from './resolve';
import { scanSwift } from './scan';

export { scanSwift, stripSwiftComments } from './scan';
export { createSwiftResolver, parsePackageManifest } from './resolve';
export { SWIFT_QUERY } from './queries';

const swift: LanguagePlugin = {
  id: 'swift',
  name: 'Swift',
  extensions: ['swift'],
  color: languageColor('swift', config.visual),
  manifests: ['Package.swift'],
  scan: (text) => scanSwift(text),
  syntax: { grammar: () => 'swift', queries: { swift: SWIFT_QUERY } },
  createResolver: createSwiftResolver,
};

export default swift;
