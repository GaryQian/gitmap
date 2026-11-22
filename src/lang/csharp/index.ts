// C# plug-in: a `using`/namespace/type scanner, a namespace-based (fuzzy) resolver with namespace
// scope keys, and a tree-sitter query for the slow pass.
import { config } from '../../config';
import type { LanguagePlugin } from '../../contracts/lang';
import { languageColor } from '../../shared';
import { CSHARP_GRAMMAR, CSHARP_QUERY } from './queries';
import { CSHARP, createCSharpResolver } from './resolve';
import { scanCSharp } from './scan';

export { scanCSharp } from './scan';
export { createCSharpResolver, NAMESPACE_CAP, SCOPE_PREFIX } from './resolve';
export { CSHARP_GRAMMAR, CSHARP_QUERY } from './queries';

const csharp: LanguagePlugin = {
  id: CSHARP,
  name: 'C#',
  extensions: ['cs'],
  color: languageColor(CSHARP, config.visual),
  scan: (text) => scanCSharp(text),
  syntax: {
    grammar: () => CSHARP_GRAMMAR,
    queries: { [CSHARP_GRAMMAR]: CSHARP_QUERY },
  },
  createResolver: createCSharpResolver,
};

export default csharp;
