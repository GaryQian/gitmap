// PHP plug-in: `use` imports through composer's PSR-4 map, literal `require` / `include` paths, and
// a tree-sitter slow pass. Templates (.phtml) are PHP with more HTML around it.
import { config } from '../../config';
import type { LanguagePlugin, ScanResult } from '../../contracts/lang';
import { languageColor } from '../../shared';
import { PHP_QUERY } from './queries';
import { createPhpResolver } from './resolve';
import { scanPhp } from './scan';

export { maskPhp, scanPhp } from './scan';
export { createPhpResolver } from './resolve';
export { PHP_QUERY } from './queries';

const GRAMMAR = 'php';

function scan(text: string): ScanResult {
  try { return scanPhp(text); } catch { return { imports: [] }; }
}

const php: LanguagePlugin = {
  id: 'php',
  name: 'PHP',
  extensions: ['php', 'phtml'],
  color: languageColor('php', config.visual),
  manifests: ['composer.json'],
  scan,
  syntax: { grammar: () => GRAMMAR, queries: { [GRAMMAR]: PHP_QUERY } },
  createResolver: createPhpResolver,
};

export default php;
