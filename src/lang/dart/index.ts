// Dart plug-in: directive scanner, pubspec-based resolver and the tree-sitter query of the slow pass.
import { config } from '../../config';
import type { LanguagePlugin } from '../../contracts/lang';
import { languageColor } from '../../shared';
import { DART_QUERY } from './queries';
import { createDartResolver } from './resolve';
import { scanDart } from './scan';

export { scanDart } from './scan';
export type { DartImportKind } from './scan';
export { createDartResolver, readPubspec } from './resolve';
export { DART_QUERY } from './queries';

const dart: LanguagePlugin = {
  id: 'dart',
  name: 'Dart',
  extensions: ['dart'],
  color: languageColor('dart', config.visual),
  manifests: ['pubspec.yaml'],
  scan: (text) => scanDart(text),
  syntax: { grammar: () => 'dart', queries: { dart: DART_QUERY } },
  createResolver: createDartResolver,
};

export default dart;
