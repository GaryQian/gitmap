// Stylesheet plug-in: CSS, SCSS, Sass and Less under the one id `css` (config has one colour for
// them). They share the scanner and the resolver, so a .scss file can import a .css file. Fast pass
// only: stylesheets have no slow pass (PLAN.md §6.3). The scanner and resolver are also what the HTML
// and Vue / Svelte / Astro plug-ins use for `<style>` blocks.
import { config } from '../../config';
import type { LanguagePlugin } from '../../contracts/lang';
import { extname, languageColor } from '../../shared';
import { styleResolver } from './resolve';
import { scanStyles, styleSyntax } from './scan';

export { scanStyles, styleSyntax, type StyleSyntax } from './scan';
export { styleResolver } from './resolve';
export { aliasCandidates, aliasRest, cleanSpec, CONVENTION, isLocalSpec, probeModule, resolveRootRelative } from './paths';

const css: LanguagePlugin = {
  id: 'css',
  name: 'CSS',
  extensions: ['css', 'scss', 'sass', 'less', 'pcss'],
  color: languageColor('css', config.visual),
  scan: (text, path) => ({ imports: scanStyles(text, styleSyntax(extname(path))) }),
  createResolver: styleResolver,
};

export default css;
