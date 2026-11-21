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
