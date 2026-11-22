// Objective-C plug-in: `.m` and `.mm` sources. Headers (`.h`) stay with the C++ plug-in of the
// C family, whose scanner already reads `#import`; includes resolve through the family's one
// resolver, so C, C++ and Objective-C share their header namespace. There is no Objective-C grammar
// for the tree-sitter runtime in use, so the slow pass is `extractSymbols` (./symbols.ts).
import { config } from '../../config';
import type { LanguagePlugin } from '../../contracts/lang';
import { languageColor } from '../../shared';
import { createObjcResolver, MODULE_MAPS } from './resolve';
import { scanObjc } from './scan';
import { extractObjcSymbols } from './symbols';

export { MODULE_IMPORT, scanObjc } from './scan';
export { createObjcResolver } from './resolve';
export { extractObjcSymbols } from './symbols';

const objc: LanguagePlugin = {
  id: 'objc',
  name: 'Objective-C',
  extensions: ['m', 'mm'],
  color: languageColor('objc', config.visual),
  manifests: [MODULE_MAPS],
  scan: (text) => scanObjc(text),
  extractSymbols: extractObjcSymbols,
  createResolver: createObjcResolver,
};

export default objc;
