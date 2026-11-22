// Go plug-in: header scanner (package clause and imports), go.mod-based package resolver, and a
// tree-sitter query for the slow pass.
import { config } from '../../config';
import type { LanguagePlugin } from '../../contracts/lang';
import { languageColor } from '../../shared';
import { GO_QUERY } from './queries';
import { createGoResolver } from './resolve';
import { scanGo } from './scan';

export { scanGo } from './scan';
export { createGoResolver, parseGoMod } from './resolve';
export { GO_QUERY } from './queries';

const go: LanguagePlugin = {
  id: 'go',
  name: 'Go',
  extensions: ['go'],
  color: languageColor('go', config.visual),
  manifests: ['go.mod'],
  scan: (text) => scanGo(text),
  // Go exports by capitalisation.
  syntax: { grammar: () => 'go', queries: { go: GO_QUERY }, exported: (name) => /^\p{Lu}/u.test(name) },
  createResolver: createGoResolver,
};

export default go;
