import { describe, expect, it } from 'vitest';
import { config, withConfig } from '../../config';
import type { TaskContext } from '../../contracts/compute';
import type { RepoAccess } from '../../contracts/git';
import type { FactsCache, ManifestEntry } from '../../contracts/ingest';
import type { LanguagePlugin, SyntaxFacts } from '../../contracts/lang';
import { fixtureExpected, fixtureFiles } from '../../testing/fixture';
import { MemoryWorkingTree, createFakePool, memoryRepo } from '../../testing/memory';
import { fakeGit } from '../fakeGit';
import { buildManifest, runSlowPass } from '../index';
import { loadWasmFile } from './loader';
import slowPassTask, { createSlowPassTask } from './slowpass.task';

async function slowPass(files: Record<string, string>, cfg = config, opts: Parameters<typeof runSlowPass>[3] = {}) {
  const repo = memoryRepo('test', files);
  const manifest = await buildManifest(repo, cfg);
  const pool = createFakePool({ config: cfg, tasks: [slowPassTask], repo });
  const facts = await runSlowPass(manifest, pool, cfg, opts);
  return { facts, by: Object.fromEntries(facts.map((f) => [f.path, f])) as Record<string, SyntaxFacts>, manifest };
}

describe('runSlowPass on fixtures/three-lang', () => {
  it('finds the definition and the reference behind every expected call edge', async () => {
    const { facts, by, manifest } = await slowPass(fixtureFiles('three-lang'));
    const { calls } = fixtureExpected<{ calls: [string, string, string][] }>('three-lang');
    expect(calls.length).toBeGreaterThan(0);
    for (const [from, to, name] of calls) {
      expect(by[to].defs.map((d) => d.name), `${to} defines ${name}`).toContain(name);
      expect(by[from].refs.map((r) => r.name), `${from} refers to ${name}`).toContain(name);
    }
    expect(by['web/src/app.ts'].refs).toContainEqual({ name: 'formatUser', kind: 'call', count: 1 });
    expect(by['web/src/app.ts'].refs).toContainEqual({ name: 'ApiClient', kind: 'type', count: 1 });
    expect(by['web/src/app.ts'].refs).toContainEqual({ name: 'fetchUser', kind: 'call', count: 1, qualifier: 'client' });
    expect(by['service/handlers.py'].refs).toContainEqual({ name: 'save', kind: 'call', count: 1, qualifier: 'db' });

    // Only files with a slow pass come back, each with its path and the manifest's oid, and none failed.
    expect(by['README.md']).toBeUndefined();
    expect(by['web/logo.png']).toBeUndefined();
    const oids = new Map(manifest.entries.map((e) => [e.path, e.oid]));
    for (const f of facts) {
      expect(f.oid).toBe(oids.get(f.path));
      expect(f.skipped, f.path).toBeUndefined();
      expect(f.errorRate, f.path).toBe(0);
    }
  });

  it('keeps a signature and the doc comment or docstring of a definition', async () => {
    const { by } = await slowPass(fixtureFiles('three-lang'));
    const fetchUser = by['web/src/api/client.ts'].defs.find((d) => d.name === 'fetchUser')!;
    expect(fetchUser).toMatchObject({ kind: 'method', container: 'ApiClient', line: 8, doc: 'Fetch one user by id.' });
    expect(fetchUser.signature).toBe('async fetchUser(id: number): Promise<User>');
    const handle = by['service/handlers.py'].defs.find((d) => d.name === 'handle_request')!;
    expect(handle).toMatchObject({ kind: 'function', doc: 'Turn arguments into a stored user.' });
    expect(handle.signature).toBe('def handle_request(conn, args):');
    const create = by['native/engine.c'].defs.find((d) => d.name === 'engine_create')!;
    expect(create.signature).toBe('Engine *engine_create(int workers)');
  });
});

describe('runSlowPass', () => {
  it('marks file-private definitions and still reads a file with a syntax error', async () => {
    const { by } = await slowPass({
      'a.ts': 'function hidden() {}\nexport function shown() { return hidden(); }\nfunction later() {}\nexport { later };\n',
      'b.py': 'def _helper():\n    pass\n\ndef public():\n    return _helper()\n',
      'c.c': 'static int helper(void) { return 1; }\nint api(void) { Lock lock(mutex); return helper(); }\n',
      'broken.ts': 'export function ok(): number { return 1; }\nfunction ( {{{ = ;\nexport function alsoOk() { return ok(); }\n',
    });
    const exported = (path: string) => Object.fromEntries(by[path].defs.map((d) => [d.name, d.exported !== false]));
    expect(exported('a.ts')).toEqual({ hidden: false, shown: true, later: true });
    expect(exported('b.py')).toEqual({ _helper: false, public: true });
    expect(exported('c.c')).toEqual({ helper: false, api: true }); // `Lock lock(mutex);` in a body is no prototype
    const broken = by['broken.ts'];
    expect(broken.skipped).toBeUndefined();
    expect(broken.errorRate).toBeGreaterThan(0);
    expect(broken.errorRate).toBeLessThan(1);
    expect(broken.defs.map((d) => d.name)).toContain('ok');
  });

  it('reports progress and batches, and resolves with what finished when the signal aborts', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 12; i++) files[`src/f${String(i).padStart(2, '0')}.ts`] = `export function f${i}() { return ${i}; }\n`;
    const cfg = withConfig({ parser: { batchBytes: 8 } }); // one file per batch
    const batches: SyntaxFacts[][] = [];
    const progress: [number, number][] = [];
    const whole = await slowPass(files, cfg, { onBatch: (b) => batches.push(b), onProgress: (d, t) => progress.push([d, t]) });
    expect(whole.facts).toHaveLength(12);
    expect(batches.length).toBeGreaterThan(2);
    expect(batches.flat()).toHaveLength(12);
    expect(progress.at(-1)).toEqual([12, 12]);

    const controller = new AbortController();
    let seen = 0;
    const partial = await slowPass(files, cfg, { signal: controller.signal, onBatch: (b) => { seen += b.length; if (seen >= 3) controller.abort(); } });
    expect(partial.facts.length).toBeGreaterThanOrEqual(3);
    expect(partial.facts.length).toBeLessThan(12);
    expect(partial.facts.length).toBe(seen);
    for (const f of partial.facts) expect(f.defs).toHaveLength(1);

    const before = new AbortController();
    before.abort();
    expect((await slowPass(files, cfg, { signal: before.signal })).facts).toEqual([]);
  });

  it('caches by oid only what was read from git, and parses nothing that is cached', async () => {
    const git = fakeGit([
      { path: 'src/packed.ts', text: 'export function staged() {}\n' },
      { path: 'src/loose.ts', text: 'export function stagedLoose() {}\n', packed: false },
    ]);
    // The working tree differs from what is staged, which shows where each file was read from.
    const tree = new MemoryWorkingTree({ 'src/packed.ts': 'export function edited() {}\n', 'src/loose.ts': 'export function onDisk() {}\n' });
    const repo: RepoAccess = { name: 'tracked', tree, git: git.fs };
    const manifest = await buildManifest(repo, config, () => git.repo);
    const pool = createFakePool({ config, tasks: [createSlowPassTask({ openGit: () => git.repo })], repo });
    const stored = new Map<string, SyntaxFacts>();
    const cache: FactsCache = {
      async getFacts() { return new Map(); },
      async putFacts() {},
      async getSyntax(oids) { return new Map(oids.filter((o) => stored.has(o)).map((o) => [o, stored.get(o)!])); },
      async putSyntax(list) { for (const f of list) stored.set(f.oid, f); },
    };

    const first = await runSlowPass(manifest, pool, config, { cache });
    const names = (facts: SyntaxFacts[]) => Object.fromEntries(facts.map((f) => [f.path, f.defs[0]?.name]));
    expect(names(first)).toEqual({ 'src/packed.ts': 'staged', 'src/loose.ts': 'onDisk' });
    expect([...stored.keys()]).toEqual([git.oidOf('src/packed.ts')]);

    git.reads.length = 0;
    const batches: string[][] = [];
    const second = await runSlowPass(manifest, pool, config, { cache, onBatch: (b) => batches.push(b.map((f) => f.path)) });
    expect(names(second)).toEqual(names(first));
    expect(batches[0]).toEqual(['src/packed.ts']); // the cache hits come first, as one batch
    expect(git.reads).toEqual([]);
  });
});

describe('the slow-pass task', () => {
  const entry = (path: string, lang: string, text: string): ManifestEntry => ({ path, oid: '', bytes: text.length, lang, read: 'tree', packOffset: -1 });
  const plugin = (id: string, rest: Partial<LanguagePlugin>): LanguagePlugin => ({ id, name: id, extensions: [id], color: '#000000', scan: () => ({ imports: [] }), ...rest });
  const context = (files: Record<string, string>, cfg = config): TaskContext => {
    const repo = memoryRepo('test', files);
    return { config: cfg, repo: async () => repo, cache: new Map(), transfer() {} };
  };

  it('remembers a grammar that does not load and falls back to extractSymbols, else skips the file', async () => {
    const plugins: Record<string, LanguagePlugin> = {
      regex: plugin('regex', {
        syntax: { grammar: () => 'nope', queries: { nope: '(identifier) @name' } },
        extractSymbols: (text) => ({ defs: [{ name: text.trim(), kind: 'function', line: 1 }], refs: [] }),
      }),
      bare: plugin('bare', { syntax: { grammar: () => 'nope', queries: { nope: '(identifier) @name' } } }),
      badquery: plugin('badquery', { syntax: { grammar: () => 'python', queries: { python: '(no_such_node) @definition.function' } } }),
      generic: plugin('generic', { syntax: { grammar: () => 'python', queries: { python: '(function_definition name: (identifier) @name) @definition.function' } } }),
    };
    const loads: string[] = [];
    const task = createSlowPassTask({
      lookup: (id) => plugins[id],
      loadWasm: async (file) => { loads.push(file); if (file.includes('nope')) throw new Error('404'); return loadWasmFile(file); },
    });
    const files = { 'a.regex': 'alpha\n', 'b.bare': 'beta\n', 'c.badquery': 'def c(): pass\n', 'd.generic': 'def d(): pass\n' };
    const entries = [entry('a.regex', 'regex', files['a.regex']), entry('b.bare', 'bare', files['b.bare']), entry('c.badquery', 'badquery', files['c.badquery']), entry('d.generic', 'generic', files['d.generic'])];
    const ctx = context(files);
    const warn = console.warn;
    console.warn = () => {};
    try {
      const out = await task.run({ entries }, ctx);
      expect(out.map((f) => [f.path, f.skipped, f.defs.map((d) => d.name)])).toEqual([
        ['a.regex', undefined, ['alpha']],
        ['b.bare', 'no-grammar', []],
        ['c.badquery', 'error', []],
        ['d.generic', undefined, ['d']], // any plug-in's query runs, not only the built-in three
      ]);
      await task.run({ entries }, ctx);
      expect(loads.filter((f) => f.includes('nope'))).toHaveLength(1);
    } finally { console.warn = warn; }
  });

  it('skips a file past the time cap or the size cap, and the parser still works afterwards', async () => {
    const files = { 'a.ts': 'export function a() {}\n' };
    const entries = [entry('a.ts', 'ts', files['a.ts'])];
    const ctx = context(files, withConfig({ reveal: { perFileTimeoutMs: -1 } }));
    expect((await slowPassTask.run({ entries }, ctx))[0]).toMatchObject({ skipped: 'timeout', defs: [] });
    expect((await slowPassTask.run({ entries }, { ...ctx, config: withConfig({ parser: { maxFileBytes: 4 } }) }))[0].skipped).toBe('too-large');
    expect((await slowPassTask.run({ entries }, { ...ctx, config }))[0].defs.map((d) => d.name)).toEqual(['a']);
  });
});
