// C and C++ plug-ins. Headers (.h and friends) count as C++, as in the scan spike. The family shares
// one include scanner and one resolver, because the languages share their headers; an Objective-C
// plug-in added to this folder later joins the exported array and reuses both. The slow-pass
// queries (tree-sitter) are in ./queries.ts.
import { config } from '../../config';
import type { LanguagePlugin } from '../../contracts/lang';
import { languageColor } from '../../shared';
import { cSyntax, cppSyntax } from './queries';
import { includeResolver } from './resolve';
import { scanIncludes } from './scan';

export { blankComments, scanIncludes } from './scan';
export { includeResolver } from './resolve';

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
  scan: (text) => scanIncludes(text),
  syntax: cppSyntax,
  createResolver: includeResolver,
};

export default [c, cpp];
