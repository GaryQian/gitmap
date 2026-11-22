// Python plug-in. The slow-pass query (tree-sitter) is in ./queries.ts.
import { config } from '../../config';
import type { LanguagePlugin } from '../../contracts/lang';
import { languageColor } from '../../shared';
import { pythonSyntax } from './queries';
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
  syntax: pythonSyntax,
  createResolver: createPythonResolver,
};

export default python;
