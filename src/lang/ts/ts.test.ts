import { describe, expect, it } from 'vitest';
import type { FileFacts } from '../../contracts/lang';
import { createRepoIndex } from '../../shared/repoIndex';
import plugins, { parseJsonc, scanImports, tsResolver } from './index';

const file = (path: string, excerpt?: string): FileFacts => ({ path, oid: '', bytes: 0, lang: /\.[mc]?jsx?$/.test(path) ? 'js' : 'ts', loc: 1, imports: [], ...(excerpt === undefined ? {} : { excerpt }) });
const specs = (text: string) => scanImports(text).imports.map((i) => `${i.kind}:${i.spec}`);

describe('ts/js scanner', () => {
  it('finds static imports, re-exports, require and dynamic import, with names', () => {
    const { imports } = scanImports([
      `import def, { a, b as c, type T } from './one';`,
      `import * as ns from "./two";`,
      `import type { U } from './three';`,
      `import './side-effect';`,
      `export { x as y } from './four';`,
      `export * from './five';`,
      `const six = require('./six');`,
      `const seven = await import('./seven');`,
      `import {`,
      `  multi, // a comment between names`,
      `  line,`,
      `} from './eight';`,
    ].join('\n'));
    expect(imports).toEqual([
      { spec: './one', kind: 'import', names: ['default', 'a', 'b', 'T'] },
      { spec: './two', kind: 'import', names: ['*'] },
      { spec: './three', kind: 'import', names: ['U'] },
      { spec: './side-effect', kind: 'import' },
      { spec: './four', kind: 'export', names: ['x'] },
      { spec: './five', kind: 'export', names: ['*'] },
      { spec: './six', kind: 'require' },
      { spec: './seven', kind: 'dynamic' },
      { spec: './eight', kind: 'import', names: ['multi', 'line'] },
    ]);
  });

  it('ignores imports inside comments, strings, templates and regex literals', () => {
    const text = [
      `// import a from './comment';`,
      `/* import b from './block';`,
      `   require('./block2') */`,
      `const s = "import c from './string'";`,
      `const t = \`import d from './template' \${require('./inside-interpolation')} import('./template2')\`;`,
      `const r = /import e from '.\\/regex'/.test(s) ? 1 / 2 : 3;`,
      `const q = "it's"; const u = 'say "hi"';`,
      `obj.require('./property'); obj.import('./property2');`,
      `export const value = 1; export { s, t };`,
      `import real from './real';`,
    ].join('\n');
    expect(specs(text)).toEqual(['require:./inside-interpolation', 'import:./real']);
  });

  it('never throws on malformed input', () => {
    for (const text of ['import', 'import {', 'import { a, from', 'export * as', 'require(', '`${', "import x from 'unterminated", '/'.repeat(50)]) {
      expect(() => scanImports(text)).not.toThrow();
    }
  });
});

describe('ts/js resolver', () => {
  const tsconfig = `{
    // comments and trailing commas are allowed here
    "extends": "./tsconfig.base.json",
    "compilerOptions": {
      "paths": { "@lib/*": ["src/lib/*"], "config": ["src/settings/config.ts"], },
    },
  }`;
  const files: FileFacts[] = [
    file('app/tsconfig.json', tsconfig),
    file('app/tsconfig.base.json', '{ "compilerOptions": { "baseUrl": "." } }'),
    file('app/src/main.ts'),
    file('app/src/lib/math.ts'),
    file('app/src/lib/widgets/index.tsx'),
    file('app/src/settings/config.ts'),
    file('app/src/styles.css'),
    file('app/src/old.js'),
    file('packages/core/package.json', '{ "name": "@acme/core", "main": "./dist/index.js", "exports": { ".": "./dist/index.js", "./tools/*": "./dist/tools/*.js" } }'),
    file('packages/core/src/index.ts'),
    file('packages/core/src/tools/hammer.ts'),
    file('packages/plain/package.json', '{ "name": "plain" }'),
    file('packages/plain/index.js'),
  ];
  const index = createRepoIndex(files);
  const resolver = tsResolver(index);
  const from = index.get('app/src/main.ts')!;
  const to = (spec: string, f = from) => resolver.resolve(f, { spec, kind: 'import' }).map((r) => r.path);

  it('probes extensions and index files, and maps ./x.js to ./x.ts', () => {
    expect(to('./lib/math')).toEqual(['app/src/lib/math.ts']);
    expect(to('./lib/math.js')).toEqual(['app/src/lib/math.ts']);
    expect(to('./lib/widgets')).toEqual(['app/src/lib/widgets/index.tsx']);
    expect(to('./styles.css?inline')).toEqual(['app/src/styles.css']);
    expect(to('./main', index.get('app/src/old.js')!)).toEqual(['app/src/main.ts']);
    expect(to('./missing')).toEqual([]);
    expect(to('../../../outside')).toEqual([]);
  });

  it('applies tsconfig paths and baseUrl from the nearest config, through extends', () => {
    expect(to('@lib/math')).toEqual(['app/src/lib/math.ts']);
    expect(to('config')).toEqual(['app/src/settings/config.ts']);
    expect(to('src/lib/math')).toEqual(['app/src/lib/math.ts']); // baseUrl
    expect(to('@lib/math', index.get('packages/core/src/index.ts')!)).toEqual([]); // outside that tsconfig
  });

  it('resolves workspace packages by name and treats unknown bare specifiers as external', () => {
    expect(to('@acme/core')).toEqual(['packages/core/src/index.ts']);
    expect(to('@acme/core/tools/hammer')).toEqual(['packages/core/src/tools/hammer.ts']);
    expect(to('plain')).toEqual(['packages/plain/index.js']);
    expect(to('react')).toEqual([]);
    expect(to('node:fs')).toEqual([]);
  });

  it('shares one resolver between the ts and js plug-ins', () => {
    const [ts, js] = plugins;
    expect(ts.createResolver!(index)).toBe(js.createResolver!(index));
  });

  it('parses JSON with comments and trailing commas', () => {
    expect(parseJsonc('{ "a": [1, 2,], /* c */ "b": "x // not a comment", }')).toEqual({ a: [1, 2], b: 'x // not a comment' });
    expect(parseJsonc('not json')).toBeUndefined();
  });
});

describe('ts/js resolver: conventional aliases and component files', () => {
  const index = createRepoIndex([
    // A Vite / SvelteKit style project: no tsconfig in the repo maps '@', '~' or '$lib'.
    file('web/package.json', '{ "name": "web" }'),
    file('web/src/main.ts'),
    file('web/src/views/Home.ts'),
    file('web/src/components/Button.tsx'),
    file('web/src/lib/util.ts'),
    file('web/src/App.vue'),
    file('web/src/Card.ts'),
    file('web/src/Card.vue'),
    file('web/src/routes/Page.svelte'),
    file('web/layouts/default.ts'),
    file('web/src/scope/pkg.ts'), // what '@scope/pkg' would hit if it were read as the '@/' alias
    file('web/src/other/thing.ts'),
    // A project whose tsconfig maps '@/*' somewhere else than src/.
    file('mapped/tsconfig.json', '{ "compilerOptions": { "paths": { "@/*": ["./app/*"] } } }'),
    file('mapped/src/main.ts'),
    file('mapped/src/components/Button.ts'),
    file('mapped/app/components/Button.ts'),
    file('packages/pkg/package.json', '{ "name": "@scope/pkg" }'),
    file('packages/pkg/src/index.ts'),
  ]);
  const resolver = tsResolver(index);
  const resolve = (spec: string, from = 'web/src/views/Home.ts') => resolver.resolve(index.get(from)!, { spec, kind: 'import' });
  const to = (spec: string, from?: string) => resolve(spec, from).map((r) => r.path);

  it('falls back to the src/ convention for @/ and ~/, and to src/lib for $lib', () => {
    expect(to('@/components/Button')).toEqual(['web/src/components/Button.tsx']);
    expect(to('~/components/Button')).toEqual(['web/src/components/Button.tsx']);
    expect(to('$lib/util')).toEqual(['web/src/lib/util.ts']);
    expect(to('~/layouts/default')).toEqual(['web/layouts/default.ts']); // beside the package.json, as in Nuxt
    expect(to('@/missing')).toEqual([]);
    expect(to('$lib/missing')).toEqual([]);
    // A convention is a guess: less sure than a mapping read from the repo.
    expect(resolve('@/components/Button')[0].confidence).toBeLessThan(1);
    expect(resolve('@/components/Button')[0].confidence).toBeGreaterThan(0.5);
  });

  it('lets a tsconfig mapping win over the convention', () => {
    const hit = resolve('@/components/Button', 'mapped/src/main.ts');
    expect(hit).toEqual([{ path: 'mapped/app/components/Button.ts', confidence: 1 }]);
  });

  it('does not take a scoped package for the @/ alias', () => {
    expect(resolve('@scope/pkg')).toEqual([{ path: 'packages/pkg/src/index.ts', confidence: 1 }]);
    expect(to('@other/thing')).toEqual([]); // not a package of the repo: external
  });

  it('finds a component file when the extension is left off, after the script extensions', () => {
    expect(to('./App', 'web/src/main.ts')).toEqual(['web/src/App.vue']);
    expect(to('./App.vue', 'web/src/main.ts')).toEqual(['web/src/App.vue']);
    expect(to('./routes/Page', 'web/src/main.ts')).toEqual(['web/src/routes/Page.svelte']);
    expect(to('@/App')).toEqual(['web/src/App.vue']);
    expect(to('./Card', 'web/src/main.ts')).toEqual(['web/src/Card.ts']);
    expect(to('./Card.vue', 'web/src/main.ts')).toEqual(['web/src/Card.vue']);
  });
});
