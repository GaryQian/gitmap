import { describe, expect, it } from 'vitest';
import { config, withConfig } from '../config';
import type { RepoAccess } from '../contracts/git';
import type { FactsCache } from '../contracts/ingest';
import type { FileFacts, LanguagePlugin } from '../contracts/lang';
import { MemoryWorkingTree, createFakePool, memoryRepo } from '../testing/memory';
import { factsFromBytes } from './facts';
import { fakeGit } from './fakeGit';
import fastPassTask, { createFastPassTask } from './fastpass.task';
import { buildManifest, runFastPass } from './index';

function memoryCache(): FactsCache & { facts: Map<string, FileFacts> } {
  const facts = new Map<string, FileFacts>();
  return {
    facts,
    async getFacts(oids) { return new Map(oids.filter((o) => facts.has(o)).map((o) => [o, facts.get(o)!])); },
    async putFacts(list) { for (const f of list) facts.set(f.oid, f); },
    async getSyntax() { return new Map(); },
    async putSyntax() {},
  };
}

describe('runFastPass', () => {
  it('returns one fact per manifest entry, in manifest order, for a plain folder', async () => {
    const cfg = withConfig({ parser: { maxFileBytes: 400, batchBytes: 64 } });
    const repo = memoryRepo('plain', {
      'README.md': '# Title\n\nSome words.\n',
      'tsconfig.json': '{ "compilerOptions": { "baseUrl": "." } }\n',
      'src/a.ts': "import { b } from './b';\nexport const a = b;\n",
      'src/b.ts': 'export const b = 1;',
      'src/tool.py': 'from . import helper\nimport os\n',
      'native/x.c': '#include "x.h"\n#include <stdio.h>\n',
      'notes.txt': 'one\ntwo\nthree\n',
      'blob.dat': new Uint8Array([1, 2, 0, 3]),
      'logo.png': 'png bytes',
      'big.ts': '// filler\n'.repeat(60),
    });
    const manifest = await buildManifest(repo, cfg);
    const pool = createFakePool({ config: cfg, tasks: [fastPassTask], repo });
    const progress: [number, number][] = [];
    const facts = await runFastPass(manifest, pool, cfg, { onProgress: (done, total) => progress.push([done, total]) });

    expect(facts.map((f) => f.path)).toEqual(manifest.entries.map((e) => e.path));
    const by = Object.fromEntries(facts.map((f) => [f.path, f]));
    expect(by['src/a.ts']).toMatchObject({ lang: 'ts', loc: 2, imports: [{ spec: './b', kind: 'import', names: ['b'] }] });
    expect(by['src/b.ts'].loc).toBe(1);
    expect(by['src/tool.py'].imports.map((i) => i.spec)).toEqual(['.', 'os']);
    expect(by['native/x.c'].imports.map((i) => i.kind)).toEqual(['include', 'include-system']);
    expect(by['notes.txt']).toMatchObject({ lang: null, loc: 3, imports: [] });
    expect(by['blob.dat']).toMatchObject({ loc: 0, skipped: 'binary' });
    expect(by['logo.png']).toMatchObject({ loc: 0, skipped: 'binary' });
    expect(by['big.ts']).toMatchObject({ loc: 0, skipped: 'too-large' });
    expect(by['README.md'].excerpt).toContain('# Title');
    expect(by['tsconfig.json'].excerpt).toContain('baseUrl');
    expect(by['src/a.ts'].excerpt).toBeUndefined();
    expect(progress.length).toBeGreaterThan(2); // several batches
    expect(progress.at(-1)).toEqual([facts.length, facts.length]);
    for (let i = 1; i < progress.length; i++) expect(progress[i][0]).toBeGreaterThanOrEqual(progress[i - 1][0]);
  });

  it('reads packed blobs from git, loose ones from the working tree, and caches only what git vouches for', async () => {
    const git = fakeGit([
      { path: 'src/packed.ts', text: "import './staged';\n" },
      { path: 'src/loose.ts', text: "import './staged-loose';\n", packed: false },
      { path: 'src/gone.ts', text: "import './unused';\n" },
    ]);
    // The working tree differs from what is staged, which shows where each file was read from.
    const tree = new MemoryWorkingTree({ 'src/packed.ts': "import './edited';\n", 'src/loose.ts': "import './on-disk';\n", 'src/gone.ts': "import './fallback';\n" });
    const repo: RepoAccess = { name: 'tracked', tree, git: git.fs };
    const manifest = await buildManifest(repo, config, () => git.repo);
    const gone = git.oidOf('src/gone.ts');
    const worker = { ...git.repo, readObject: (oid: string) => (oid === gone ? null : git.repo.readObject(oid)) }; // a pack miss
    let opened = 0;
    const task = createFastPassTask(() => { opened++; return worker; });
    const pool = createFakePool({ config, tasks: [task], repo });
    const cache = memoryCache();

    const first = await runFastPass(manifest, pool, config, { cache });
    const spec = (facts: FileFacts[], path: string) => facts.find((f) => f.path === path)!.imports[0].spec;
    expect(spec(first, 'src/packed.ts')).toBe('./staged');
    expect(spec(first, 'src/loose.ts')).toBe('./on-disk');
    expect(spec(first, 'src/gone.ts')).toBe('./fallback');
    expect(first.map((f) => f.oid)).toEqual(manifest.entries.map((e) => e.oid));
    expect([...cache.facts.keys()]).toEqual([git.oidOf('src/packed.ts')]);

    git.reads.length = 0;
    const second = await runFastPass(manifest, pool, config, { cache });
    expect(second).toEqual(first);
    expect(git.reads).toEqual([]); // the cached blob was not read again
    expect(opened).toBe(1); // one GitRepo per worker, kept between tasks
  });

  it('rejects when the signal aborts', async () => {
    const repo = memoryRepo('plain', { 'a.ts': 'export {};\n' });
    const manifest = await buildManifest(repo, config);
    const pool = createFakePool({ config, tasks: [fastPassTask], repo });
    const controller = new AbortController();
    const run = runFastPass(manifest, pool, config, { signal: controller.signal });
    controller.abort();
    await expect(run).rejects.toBeTruthy();
  });
});

describe('factsFromBytes', () => {
  const entry = { path: 'x.boom', oid: 'a'.repeat(40), bytes: 6, lang: 'boom', read: 'tree' as const, packOffset: -1 };
  const bytes = new TextEncoder().encode('a\nb\nc\n');
  const plugin = (scan: LanguagePlugin['scan']): LanguagePlugin => ({ id: 'boom', name: 'Boom', extensions: ['boom'], color: '#000000', scan });

  it('keeps the file, without imports, when its scanner throws', () => {
    const facts = factsFromBytes(entry, bytes, config, () => plugin(() => { throw new Error('scanner bug'); }));
    expect(facts).toMatchObject({ path: 'x.boom', loc: 3, imports: [] });
    expect(facts.skipped).toBeUndefined();
  });

  it('marks a file that ran past the per-file time cap and drops its imports', () => {
    const instant = withConfig({ reveal: { perFileTimeoutMs: -1 } });
    const facts = factsFromBytes(entry, bytes, instant, () => plugin(() => ({ imports: [{ spec: './y', kind: 'import' }] })));
    expect(facts).toMatchObject({ loc: 0, imports: [], skipped: 'timeout' });
  });
});
