import { describe, expect, it } from 'vitest';
import type { FileFacts } from '../../contracts/lang';
import { createRepoIndex } from '../../shared/repoIndex';
import { fixtureExpected, fixtureFiles } from '../../testing/fixture';
import html, { scanHtml, scanMarkup } from './index';

const file = (path: string, lang = 'html'): FileFacts => ({ path, oid: '', bytes: 0, lang, loc: 1, imports: [] });
const specs = (text: string) => scanHtml(text).imports.map((i) => `${i.kind}:${i.spec}`);

describe('html scanner', () => {
  it('finds script, link and img references and the imports of inline scripts and styles', () => {
    const text = [
      `<!DOCTYPE html><html><head>`,
      `<LINK REL="stylesheet" HREF="css/site.css">`,
      `<link rel=icon href=/favicon.ico>`,
      `<link rel="preconnect" href="https://fonts.example.com">`,
      `<style>@import "inline.css"; body { background: url(img/bg.png) }</style>`,
      `<script src="https://cdn.example.com/lib.js"></script>`,
      `<script src="js/vendor.js" defer></script>`,
      `<script type="module">import { start } from './js/app.js'; start();</script>`,
      `<script type="application/json">{ "import": "import x from './data.js'" }</script>`,
      `</head><body><img alt="a > b" src="img/logo.png"><img src="{{ user.avatar }}"><img src="data:image/png;base64,AAAA"></body></html>`,
    ].join('\n');
    expect(specs(text)).toEqual([
      'link:css/site.css', 'link:/favicon.ico', 'css-import:inline.css', 'css-url:img/bg.png',
      'script:js/vendor.js', 'import:./js/app.js', 'img:img/logo.png',
    ]);
  });

  it('skips comments, and does not read the inside of a script as markup', () => {
    const text = [
      `<!-- <script src="commented.js"></script> <link href="commented.css"> -->`,
      `<script>`,
      `  const a = '<script src="in-string.js"></script>';`,
      `  const b = \`<link href="in-template.css"> </script>\`;`,
      `  /* </script> <img src="in-comment.png"> */`,
      `  import('./lazy.js');`,
      `</script>`,
      `<script>// a line comment ends with the tag </script>`,
      `<img src="after.png">`,
    ].join('\n');
    expect(specs(text)).toEqual(['dynamic:./lazy.js', 'img:after.png']);
    for (const broken of ['<script', '<script src="x', '<script>import x from "y"', '<link href=', '<!-- open', '<style>@import "a.css"', '<']) {
      expect(() => scanHtml(broken)).not.toThrow();
    }
  });

  it('reads attributes in any quoting, and closes a script at the first tag when the careful reading finds none', () => {
    const [a, b] = scanMarkup(`<script lang=ts setup data-x='1'>let re = /\`/;</script><style scoped lang="scss">a{}</style>`, new Set(['script', 'style']));
    expect(a.attrs).toEqual({ lang: 'ts', setup: '', 'data-x': '1' });
    expect(a.body).toBe('let re = /`/;');
    expect(b.attrs).toEqual({ scoped: '', lang: 'scss' });
    expect(b.body).toBe('a{}');
  });
});

describe('html resolver', () => {
  const index = createRepoIndex([
    file('index.html'), file('about/index.html'), file('css/site.css', 'css'), file('js/app.ts', 'ts'), file('js/vendor.js', 'js'),
    file('public/favicon.ico', ''), file('img/logo.png', ''),
    file('apps/web/index.html'), file('apps/web/src/main.ts', 'ts'), file('apps/web/public/robots.txt', ''),
  ]);
  const resolver = html.createResolver!(index);
  const to = (spec: string, kind: string, from = 'index.html') => resolver.resolve(index.get(from)!, { spec, kind }).map((r) => r.path);

  it('resolves relative to the page, and root-relative against the page folder, the repo root and public/', () => {
    expect(to('css/site.css', 'link')).toEqual(['css/site.css']);
    expect(to('js/vendor.js?v=2', 'script')).toEqual(['js/vendor.js']);
    expect(to('js/app.js', 'script')).toEqual(['js/app.ts']); // the build output of a TS source
    expect(to('./js/app.js', 'import')).toEqual(['js/app.ts']);
    expect(to('../img/logo.png', 'img', 'about/index.html')).toEqual(['img/logo.png']);
    expect(to('/css/site.css', 'link', 'about/index.html')).toEqual(['css/site.css']);
    expect(to('/favicon.ico', 'link')).toEqual(['public/favicon.ico']);
    expect(to('/src/main.ts', 'script', 'apps/web/index.html')).toEqual(['apps/web/src/main.ts']);
    expect(to('/robots.txt', 'link', 'apps/web/index.html')).toEqual(['apps/web/public/robots.txt']);
  });

  it('returns nothing for external URLs and missing files', () => {
    expect(to('https://cdn.example.com/lib.js', 'script')).toEqual([]);
    expect(to('//cdn.example.com/lib.js', 'script')).toEqual([]);
    expect(to('js/missing.js', 'script')).toEqual([]);
    expect(to('react', 'import')).toEqual([]);
    expect(to('/nowhere.css', 'link')).toEqual([]);
  });
});

describe('pages of the web fixture', () => {
  it('link as expected', () => {
    const texts = fixtureFiles('web');
    const expected = fixtureExpected<{ imports: [string, string][]; notImports: [string, string][] }>('web');
    const isPage = (path: string) => /\.html?$/.test(path);
    const files = Object.keys(texts).sort().map((path): FileFacts => ({ ...file(path, isPage(path) ? 'html' : ''), ...(isPage(path) ? html.scan(texts[path], path) : {}) }));
    const index = createRepoIndex(files);
    const resolver = html.createResolver!(index);
    const edges = new Set(files.flatMap((f) => f.imports.flatMap((imp) => resolver.resolve(f, imp).map((r) => `${f.path} -> ${r.path}`))));
    const mine = (pairs: [string, string][]) => pairs.filter(([src]) => isPage(src)).map(([src, dst]) => `${src} -> ${dst}`);
    expect(mine(expected.imports).length).toBe(3);
    for (const e of mine(expected.imports)) expect(edges, e).toContain(e);
    for (const e of mine(expected.notImports)) expect(edges, e).not.toContain(e);
  });
});
