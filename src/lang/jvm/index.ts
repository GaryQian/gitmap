// Java, Kotlin and Scala plug-ins. They share one namespace, so they share the scanner and one
// resolver instance: a Kotlin file importing a Java or Scala class resolves directly. Java's slow
// pass is a tree-sitter query; Kotlin and Scala have no grammar for the runtime and use the
// regular-expression extractor in ./symbols.ts instead.
import { config } from '../../config';
import type { LanguagePlugin } from '../../contracts/lang';
import { languageColor } from '../../shared';
import { JAVA_QUERY } from './queries';
import { jvmResolver } from './resolve';
import { scanJvm } from './scan';
import { extractJvmSymbols } from './symbols';

export { maskJvm } from './mask';
export { JAVA_QUERY } from './queries';
export { jvmResolver } from './resolve';
export { scanJvm } from './scan';
export { extractJvmSymbols } from './symbols';

const java: LanguagePlugin = {
  id: 'java',
  name: 'Java',
  extensions: ['java'],
  color: languageColor('java', config.visual),
  scan: (text) => scanJvm(text, 'java'),
  syntax: { grammar: () => 'java', queries: { java: JAVA_QUERY } },
  createResolver: jvmResolver,
};

const kotlin: LanguagePlugin = {
  id: 'kotlin',
  name: 'Kotlin',
  extensions: ['kt', 'kts'],
  color: languageColor('kotlin', config.visual),
  scan: (text) => scanJvm(text, 'kotlin'),
  extractSymbols: (text) => extractJvmSymbols(text, 'kotlin'),
  createResolver: jvmResolver,
};

const scala: LanguagePlugin = {
  id: 'scala',
  name: 'Scala',
  extensions: ['scala', 'sc'],
  color: languageColor('scala', config.visual),
  scan: (text) => scanJvm(text, 'scala'),
  extractSymbols: (text) => extractJvmSymbols(text, 'scala'),
  createResolver: jvmResolver,
};

export default [java, kotlin, scala];
