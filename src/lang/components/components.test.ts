import { describe, expect, it } from 'vitest';
import type { FileFacts, LanguagePlugin } from '../../contracts/lang';
import { extname } from '../../shared';
import { createRepoIndex } from '../../shared/repoIndex';
import { fixtureExpected, fixtureFiles } from '../../testing/fixture';
import cssPlugin from '../css';
import htmlPlugin from '../html';
import tsPlugins from '../ts';
import components, { componentResolver, extractComponentSymbols, scanComponent, splitComponent } from './index';

const file = (path: string, excerpt?: string): FileFacts => ({ path, oid: '', bytes: 0, lang: extname(path), loc: 1, imports: [], ...(excerpt === undefined ? {} : { excerpt }) });
const specs = (text: string, kind: 'vue' | 'svelte' | 'astro') => scanComponent(text, kind).imports.map((i) => `${i.kind}:${i.spec}`);

describe('web fixture', () => {
  const plugins: LanguagePlugin[] = [...components, cssPlugin, htmlPlugin, ...tsPlugins];
  const pluginFor = (path: string) => plugins.find((p) => p.extensions.includes(extname(path)));
  const texts = fixtureFiles('web');
  const expected = fixtureExpected<{ imports: [string, string][]; notImports: [string, string][]; external: string[] }>('web');
  const files = Object.keys(texts).sort().map((path): FileFacts => {
    const plugin = pluginFor(path);
    return {
      path, oid: '', bytes: texts[path].length, lang: plugin?.id ?? null, loc: texts[path].split('\n').length,
      ...(plugin ? plugin.scan(texts[path], path) : { imports: [] }),
      ...(path.endsWith('.json') ? { excerpt: texts[path] } : {}),
    };
  });
  const index = createRepoIndex(files);
  const edges = new Set<string>();
  const unresolved = new Set<string>();
  for (const f of files) {
    const resolver = plugins.find((p) => p.id === f.lang)?.createResolver?.(index);
    for (const imp of f.imports) {
      const targets = resolver?.resolve(f, imp) ?? [];
      if (targets.length === 0) unresolved.add(imp.spec);
      for (const t of targets) edges.add(`${f.path} -> ${t.path}`);
    }
  }

  it('resolves every expected import and none of the forbidden ones', () => {
    for (const [src, dst] of expected.imports) expect(edges, `${src} -> ${dst}`).toContain(`${src} -> ${dst}`);
    for (const [src, dst] of expected.notImports) expect(edges, `${src} -> ${dst}`).not.toContain(`${src} -> ${dst}`);
    // Nothing beyond what is listed: an edge the fixture does not expect is a false link.
    expect([...edges].sort()).toEqual(expected.imports.map(([src, dst]) => `${src} -> ${dst}`).sort());
  });

  it('leaves packages unresolved, and a .ts file reaches a component through the TS plug-in', () => {
    for (const spec of expected.external) expect(unresolved, spec).toContain(spec);
    expect(index.get('src/main.ts')!.lang).toBe('ts');
    expect(edges).toContain('src/main.ts -> src/App.vue');
  });

  it('finds component references and script symbols', () => {
    const app = extractComponentSymbols(texts['src/App.vue'], 'src/App.vue', 'vue');
    expect(app.defs).toContainEqual({ name: 'App', kind: 'class', line: 1, exported: true });
    expect(app.defs).toContainEqual({ name: 'addUser', kind: 'function', line: 9, exported: false, signature: 'function addUser(first: string, last: string)' });
    expect(app.refs).toContainEqual({ name: 'UserCard', kind: 'reference', count: 1 });
    expect(app.refs).toContainEqual({ name: 'formatName', kind: 'call', count: 1 });
    expect(app.refs).toContainEqual({ name: 'addUser', kind: 'call', count: 1 }); // from @click in the template

    const counter = extractComponentSymbols(texts['src/widgets/Counter.svelte'], 'src/widgets/Counter.svelte', 'svelte');
    expect(counter.defs.map((d) => d.name)).toEqual(['Counter', 'start', 'count', 'owner']);
    expect(counter.refs).toContainEqual({ name: 'Badge', kind: 'reference', count: 1 });

    const page = extractComponentSymbols(texts['src/pages/index.astro'], 'src/pages/index.astro', 'astro');
    expect(page.refs.filter((r) => r.kind === 'reference').map((r) => r.name).sort()).toEqual(['Base', 'Counter']);
    expect(page.refs).toContainEqual({ name: 'formatName', kind: 'call', count: 1 });
  });
});

describe('component block extraction', () => {
  it('reads both script blocks of a Vue file, its style blocks and src attributes', () => {
    const text = [
      `<script lang="ts">`,
      `import type { Options } from './options';`,
      `export default { name: 'Two' };`,
      `</script>`,
      `<script setup lang="ts">`,
      `import Child from './Child.vue';`,
      `</script>`,
      `<template src="./two.html"></template>`,
      `<style lang="scss" scoped>`,
      `@use './vars'; // @use './commented';`,
      `.a { background: url(./bg.png); }`,
      `</style>`,
      `<style src="./extra.css" />`,
      `<i18n lang="json">{ "import": "x" }</i18n>`,
    ].join('\n');
    expect(specs(text, 'vue')).toEqual(['import:./options', 'import:./Child.vue', 'css-use:./vars', 'css-url:./bg.png', 'src:./two.html', 'src:./extra.css']);
  });

  it('is not fooled by tags inside strings, comments or the template', () => {
    const text = [
      `<!-- <script>import a from './in-html-comment';</script> -->`,
      `<script>`,
      `  const closing = "</script>";`,
      `  const opening = '<script>import b from "./in-string"<\\/script>';`,
      `  // <script> import c from './in-line-comment'`,
      `  /* </script><script>import d from './in-block-comment' */`,
      `  const tpl = \`</script> \${1} <style>@import "in-template.css";</style>\`;`,
      `  import Real from './Real.svelte';`,
      `</script>`,
      `<Script src="./not-a-script-tag.js" />`,
      `<p>{"<script>"} import e from './in-markup';</p>`,
      `<style>p { color: red; }</style>`,
    ].join('\n');
    expect(specs(text, 'svelte')).toEqual(['import:./Real.svelte']);
    const { scripts } = splitComponent(`<script context="module">export const a = 1;</script>\n<script>let b = 2;</script>`, 'svelte');
    expect(scripts.map((s) => s.text)).toEqual(['export const a = 1;', 'let b = 2;']);
    for (const broken of ['<script', '<script>import x from "y"', '---\nimport a from "b"', '<style lang=', '<template src=']) {
      expect(() => scanComponent(broken, 'vue')).not.toThrow();
      expect(() => scanComponent(broken, 'astro')).not.toThrow();
      expect(() => extractComponentSymbols(broken, 'x.vue', 'vue')).not.toThrow();
    }
  });

  it('reads Astro frontmatter, script blocks and style blocks', () => {
    const text = [
      `---`,
      `import Layout from '../layouts/Layout.astro';`,
      `const fence = '--- not the end';`,
      `---`,
      `<Layout><h1>--- still markup</h1></Layout>`,
      `<script>import '../scripts/menu';</script>`,
      `<script type="application/ld+json">{ "x": "import y from './json'" }</script>`,
      `<style define:vars={{ accent: '>' }}>@import '../styles/page.css';</style>`,
    ].join('\n');
    expect(specs(text, 'astro')).toEqual(['import:../layouts/Layout.astro', 'import:../scripts/menu', 'css-import:../styles/page.css']);
    expect(specs(`<h1>No frontmatter</h1>\n<script>import './a';</script>`, 'astro')).toEqual(['import:./a']);
    expect(specs(`---\n---\n<script>import './b';</script>`, 'astro')).toEqual(['import:./b']);
  });
});

describe('component resolver', () => {
  const index = createRepoIndex([
    file('tsconfig.json', '{ "compilerOptions": { "paths": { "@ui/*": ["src/ui/*"] } } }'),
    file('src/App.vue'), file('src/main.ts'), file('src/ui/Button.vue'), file('src/ui/Card/index.vue'), file('src/ui/theme.scss'),
    file('src/lib/store.ts'), file('src/routes/Page.svelte'),
  ]);
  const resolver = componentResolver(index);
  const to = (spec: string, from = 'src/App.vue', kind = 'import') => resolver.resolve(index.get(from)!, { spec, kind }).map((r) => r.path);

  it('resolves component files by extension, through tsconfig paths, and by bundler conventions', () => {
    expect(to('./ui/Button.vue')).toEqual(['src/ui/Button.vue']);
    expect(to('@ui/Button.vue')).toEqual(['src/ui/Button.vue']);
    expect(to('./ui/Button')).toEqual(['src/ui/Button.vue']); // extension left off
    expect(to('./ui/Card')).toEqual(['src/ui/Card/index.vue']);
    expect(to('@/ui/Button.vue')).toEqual(['src/ui/Button.vue']); // no tsconfig entry for '@': the src/ convention
    expect(to('$lib/store', 'src/routes/Page.svelte')).toEqual(['src/lib/store.ts']);
    expect(to('./ui/theme.scss', 'src/App.vue', 'src')).toEqual(['src/ui/theme.scss']);
    expect(to('./ui/theme', 'src/App.vue', 'css-use')).toEqual(['src/ui/theme.scss']);
    expect(to('vue')).toEqual([]);
    expect(to('./App.vue')).toEqual([]); // itself
  });

  it('shares one resolver between the three plug-ins', () => {
    const [vue, svelte, astro] = components;
    expect(vue.createResolver!(index)).toBe(svelte.createResolver!(index));
    expect(svelte.createResolver!(index)).toBe(astro.createResolver!(index));
    expect(components.map((p) => [p.id, p.extensions])).toEqual([['vue', ['vue']], ['svelte', ['svelte']], ['astro', ['astro']]]);
  });
});
