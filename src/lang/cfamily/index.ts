// C and C++ plug-ins. Headers (.h and friends) count as C++, as in the scan spike. The family shares
// one include scanner and one resolver, because the languages share their headers. The slow-pass
// queries (tree-sitter) are in ./queries.ts.
//
// Objective-C belongs to the family too. Its plug-in (`.m`, `.mm`) is src/lang/objc, but its pure
// parts live here (./objcScan.ts, ./objcSymbols.ts, ./objcResolve.ts), because `.h` is claimed by
// the C++ plug-in and an Objective-C header has to be read as Objective-C: `scan` and
// `extractSymbols` below switch on the file's text (isObjcHeader). src/lang/objc imports them from
// here, so nothing in this folder imports that one.
import { config } from '../../config';
import type { LanguagePlugin, SymbolDef, SymbolRef } from '../../contracts/lang';
import { languageColor } from '../../shared';
import { createObjcResolver, MODULE_MAPS } from './objcResolve';
import { isObjcHeader, scanObjc } from './objcScan';
import { extractObjcSymbols } from './objcSymbols';
import { cSyntax, cppSyntax } from './queries';
import { includeResolver } from './resolve';
import { scanIncludes } from './scan';

export { blankComments, scanIncludes } from './scan';
export { includeResolver } from './resolve';
export { isObjcHeader, MODULE_IMPORT, scanObjc } from './objcScan';
export { extractObjcSymbols } from './objcSymbols';
export { createObjcResolver, MODULE_MAPS } from './objcResolve';

/**
 * Slow pass of an Objective-C header, which the C++ grammar cannot read. There is no such fallback
 * for C++ itself: for any other file this throws, which the runner reports as a skipped file, as it
 * did when this plug-in had no extractSymbols (an empty result would be cached as that file's facts).
 */
function headerSymbols(text: string, path: string): { defs: SymbolDef[]; refs: SymbolRef[] } {
  if (!isObjcHeader(text, path)) throw new Error(`no symbol extractor for C++ without its grammar: ${path}`);
  return extractObjcSymbols(text, path);
}

const c: LanguagePlugin = {
  id: 'c',
  name: 'C',
  extensions: ['c'],
  color: languageColor('c', config.visual),
  scan: (text) => scanIncludes(text),
  syntax: cSyntax,
  createResolver: includeResolver,
};

const cpp: LanguagePlugin = {
  id: 'cpp',
  name: 'C++',
  extensions: ['cc', 'cpp', 'cxx', 'h', 'hh', 'hpp', 'hxx'],
  color: languageColor('cpp', config.visual),
  // An Objective-C header may `@import` a module, which the resolver finds through module maps.
  manifests: [MODULE_MAPS],
  scan: (text, path) => (isObjcHeader(text, path) ? scanObjc(text) : scanIncludes(text)),
  syntax: cppSyntax,
  extractSymbols: headerSymbols,
  // The include resolver, plus `@import` for those headers.
  createResolver: createObjcResolver,
};

export default [c, cpp];
