// Objective-C plug-in: `.m` and `.mm` sources. Headers (`.h`) stay with the C++ plug-in of the
// C family, which reads the Objective-C ones with the same scanner and extractor as this plug-in;
// that is why those live in src/lang/cfamily (objcScan.ts, objcSymbols.ts, objcResolve.ts) and are
// only re-exported here. Includes resolve through the family's one resolver, so C, C++ and
// Objective-C share their header namespace. There is no Objective-C grammar for the tree-sitter
// runtime in use, so the slow pass is `extractSymbols`.
import { config } from '../../config';
import type { LanguagePlugin } from '../../contracts/lang';
import { languageColor } from '../../shared';
import { createObjcResolver, extractObjcSymbols, MODULE_MAPS, scanObjc } from '../cfamily';

export { createObjcResolver, extractObjcSymbols, MODULE_IMPORT, scanObjc } from '../cfamily';

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
