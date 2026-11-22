// Ruby plug-in: fast-pass scanner (requires and constant references), resolver (load paths, defined
// constants, naming convention) and the tree-sitter query for the slow pass.
import { config } from '../../config';
import type { LanguagePlugin } from '../../contracts/lang';
import { languageColor } from '../../shared';
import { RUBY_QUERY } from './queries';
import { createRubyResolver } from './resolve';
import { scanRuby } from './scan';

export { scanRuby } from './scan';
export { createRubyResolver, underscore } from './resolve';
export { RUBY_QUERY } from './queries';

const ruby: LanguagePlugin = {
  id: 'ruby',
  name: 'Ruby',
  extensions: ['rb', 'rake', 'gemspec'],
  filenames: ['Rakefile', 'Gemfile'],
  color: languageColor('ruby', config.visual),
  scan: (text) => scanRuby(text),
  syntax: { grammar: () => 'ruby', queries: { ruby: RUBY_QUERY } },
  createResolver: createRubyResolver,
};

export default ruby;
