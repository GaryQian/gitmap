import { describe, expect, it } from 'vitest';
import type { FileFacts } from '../../contracts/lang';
import { extname } from '../../shared';
import { createRepoIndex } from '../../shared/repoIndex';
import { fixtureExpected, fixtureFiles } from '../../testing/fixture';
import css, { scanStyles, styleResolver, styleSyntax } from './index';

const file = (path: string, excerpt?: string): FileFacts => ({ path, oid: '', bytes: 0, lang: 'css', loc: 1, imports: [], ...(excerpt === undefined ? {} : { excerpt }) });
const specs = (text: string, lang = 'css') => scanStyles(text, styleSyntax(lang)).map((i) => `${i.kind.slice(4)}:${i.spec}`);

describe('stylesheet scanner', () => {
  it('finds @import, @use, @forward and url(), and leaves out external and computed values', () => {
    const text = [
      `@import "a.css", 'b' screen and (min-width: 100px);`,
      `@import url(c.css);`,
      `@import url("https://fonts.example.com/x.css");`,
      `@use "sass:math";`,
      `@use 'vars' as v with ($gap: 2px);`,
      `@forward "mixins" show center;`,
      `.x { background: url( "../img/a.png" ); src: url(fonts/b.woff2?v=3#iefix) format("woff2"); }`,
      `.y { background: url(data:image/png;base64,AAAA) , url(//cdn.example.com/c.png), url(#gradient), url($path), url(#{$base}/d.png); }`,
    ].join('\n');
    expect(specs(text, 'scss')).toEqual([
      'import:a.css', 'import:b', 'import:c.css', 'use:vars', 'forward:mixins', 'url:../img/a.png', 'url:fonts/b.woff2?v=3#iefix',
    ]);
  });

  it('skips comments and strings, with // comments only where the syntax has them', () => {
    const text = [
      `/* @import "block.css"; url(block.png) */`,
      `// @import "line.scss";`,
      `.a::after { content: "@import 'string.css'; url(string.png)"; }`,
      `@import "real.css";`,
    ].join('\n');
    expect(specs(text, 'scss')).toEqual(['import:real.css']);
    expect(specs(text, 'css')).toEqual(['import:line.scss', 'import:real.css']);
    expect(specs(`@import (reference) "less-options";`, 'less')).toEqual(['import:less-options']);
    expect(specs(`@import reset, theme/dark\n@use "grid"`, 'sass')).toEqual(['import:reset', 'import:theme/dark', 'use:grid']);
    for (const broken of ['@import', '@import "', 'url(', '@use', '@', 'url("x']) expect(() => specs(broken, 'scss')).not.toThrow();
  });
});

describe('stylesheet resolver', () => {
  const index = createRepoIndex([
    file('tsconfig.json', '{ "compilerOptions": { "paths": { "@/*": ["src/*"] } } }'),
    file('src/styles/app.scss'), file('src/styles/_vars.scss'), file('src/styles/plain.css'), file('src/styles/legacy.less'),
    file('src/styles/mixins/_index.scss'), file('src/styles/mixins/_flex.scss'), file('src/styles/themes/index.scss'),
    file('src/assets/logo.png'), file('public/fonts/inter.woff2'),
    file('lib/tokens/_palette.scss'), file('src/components/card.scss'),
  ]);
  const resolver = styleResolver(index);
  const to = (spec: string, kind = 'css-use', from = 'src/styles/app.scss') => resolver.resolve(index.get(from)!, { spec, kind }).map((r) => r.path);

  it('resolves partials, index files and extensions relative to the importing file', () => {
    expect(to('vars')).toEqual(['src/styles/_vars.scss']);
    expect(to('./vars')).toEqual(['src/styles/_vars.scss']);
    expect(to('vars.scss')).toEqual(['src/styles/_vars.scss']);
    expect(to('mixins')).toEqual(['src/styles/mixins/_index.scss']);
    expect(to('mixins/flex')).toEqual(['src/styles/mixins/_flex.scss']);
    expect(to('themes')).toEqual(['src/styles/themes/index.scss']);
    expect(to('plain', 'css-import')).toEqual(['src/styles/plain.css']);
    expect(to('legacy', 'css-import')).toEqual(['src/styles/legacy.less']);
    expect(to('../styles/app', 'css-import', 'src/components/card.scss')).toEqual(['src/styles/app.scss']);
    expect(to('./missing')).toEqual([]);
    expect(to('app')).toEqual([]); // itself
  });

  it('resolves assets by exact path, root-relative URLs through public/, and tsconfig aliases', () => {
    expect(to('../assets/logo.png?inline', 'css-url')).toEqual(['src/assets/logo.png']);
    expect(to('../assets/logo', 'css-url')).toEqual([]);
    expect(to('/fonts/inter.woff2', 'css-url')).toEqual(['public/fonts/inter.woff2']);
    expect(to('@/assets/logo.png', 'css-url')).toEqual(['src/assets/logo.png']);
    expect(to('@/styles/plain.css', 'css-import', 'src/components/card.scss')).toEqual(['src/styles/plain.css']);
    expect(to('~@/styles/vars', 'css-import', 'src/components/card.scss')).toEqual(['src/styles/_vars.scss']);
  });

  it('treats packages as external, and follows a load path only to a unique file', () => {
    expect(to('~bootstrap/scss/bootstrap', 'css-import')).toEqual([]);
    expect(to('bootstrap', 'css-import')).toEqual([]);
    expect(to('sass:math')).toEqual([]);
    expect(to('https://example.com/x.css', 'css-import')).toEqual([]);
    const guess = resolver.resolve(index.get('src/styles/app.scss')!, { spec: 'tokens/palette', kind: 'css-use' });
    expect(guess.map((r) => r.path)).toEqual(['lib/tokens/_palette.scss']);
    expect(guess[0].confidence).toBeLessThan(1);
  });
});

describe('stylesheets of the web fixture', () => {
  it('link as expected', () => {
    const texts = fixtureFiles('web');
    const expected = fixtureExpected<{ imports: [string, string][]; notImports: [string, string][] }>('web');
    const isStyle = (path: string) => css.extensions.includes(extname(path));
    const files = Object.keys(texts).sort().map((path): FileFacts => ({ ...file(path), ...(isStyle(path) ? css.scan(texts[path], path) : {}) }));
    const index = createRepoIndex(files);
    const resolver = css.createResolver!(index);
    const edges = new Set(files.flatMap((f) => f.imports.flatMap((imp) => resolver.resolve(f, imp).map((r) => `${f.path} -> ${r.path}`))));
    const mine = (pairs: [string, string][]) => pairs.filter(([src]) => isStyle(src)).map(([src, dst]) => `${src} -> ${dst}`);
    expect(mine(expected.imports).length).toBeGreaterThan(3);
    for (const e of mine(expected.imports)) expect(edges, e).toContain(e);
    for (const e of mine(expected.notImports)) expect(edges, e).not.toContain(e);
  });
});
