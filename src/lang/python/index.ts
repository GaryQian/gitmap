// Python plug-in. The slow pass (tree-sitter queries) is added by package 2B in ./queries.ts.
import { config } from '../../config';
import type { LanguagePlugin } from '../../contracts/lang';
import { languageColor } from '../../shared';
import { createPythonResolver } from './resolve';
import { scanPythonImports } from './scan';

export { scanPythonImports } from './scan';
export { createPythonResolver } from './resolve';

const python: LanguagePlugin = {
  id: 'python',
  name: 'Python',
  extensions: ['py', 'pyi'],
  color: languageColor('python', config.visual),
  scan: (text) => scanPythonImports(text),
  createResolver: createPythonResolver,
};

export default python;
