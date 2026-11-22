// The update flow against a real .git (fixtures/three-lang) and, for the merge, against fake passes.
import { appendFileSync, existsSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createInlinePool } from '../../compute';
import { config } from '../../config';
import type { RepoLocator } from '../../contracts/git';
import type { Manifest, ManifestEntry } from '../../contracts/ingest';
import type { FileFacts, SyntaxFacts } from '../../contracts/lang';
import { openGitRepo } from '../../git';
import { openNodeRepoAccess } from '../../git/node';
import { buildManifest } from '../../ingest';
import { buildFixtureRepo, git } from '../../testing/fixture';
import { memoryRepo } from '../../testing/memory';
import { analyzeAndApply, type PipelineDeps, type PipelineState } from '../core';
import { runHeadless } from '../node';
import { allTasks } from '../tasks';
import { applyUpdate, checkWorkingTree, confirmWorkingTree, diffManifest, planUpdate } from './index';

/**
 * A private copy of the fixture repo, put back to its last commit: a variant is rebuilt only when
 * the fixture's inputs change, so an earlier run's edits are still there.
 */
function cleanFixture(variant: string): string {
  const dir = buildFixtureRepo('three-lang', variant);
  // Never let git look for a repository above the copy: these commands rewrite the working tree.
  if (!existsSync(path.join(dir, '.git'))) throw new Error(`no fixture repo at ${dir}`);
  const env = { GIT_CEILING_DIRECTORIES: path.dirname(dir) };
  git(dir, ['reset', '-q', '--hard', 'HEAD'], env);
  git(dir, ['clean', '-fdq'], env);
  return dir;
}

describe('diffManifest and planUpdate', () => {
  it('reports a staged edit, an added file and a removed file, and nothing else', async () => {
    const dir = cleanFixture('update');
    const before = await buildManifest(await openNodeRepoAccess(dir), config);

    appendFileSync(path.join(dir, 'web/src/app.ts'), '\nexport const touched = 1;\n');
    writeFileSync(path.join(dir, 'web/src/extra.ts'), "import { startApp } from './app';\nexport const extra = startApp;\n");
    git(dir, ['add', '--', 'web/src/app.ts', 'web/src/extra.ts']);
    git(dir, ['rm', '-q', '--', 'service/db.py']);
    const after = await buildManifest(await openNodeRepoAccess(dir), config);

    const diff = diffManifest(before.entries, after);
    expect(diff.changed).toEqual(['web/src/app.ts']);
    expect(diff.added).toEqual(['web/src/extra.ts']);
    expect(diff.removed).toEqual(['service/db.py']);
    expect(diff.unchanged.length).toBe(before.entries.length - 2);

    const plan = planUpdate(before, after);
    expect(plan.reparse).toEqual(['web/src/app.ts', 'web/src/extra.ts']);
    expect(plan.drop).toEqual(['service/db.py']);
    expect(plan.count).toBe(3);
    // an oid that is not known cannot vouch for a file
    expect(diffManifest(before.entries.map((e) => ({ path: e.path, oid: '' })), before).unchanged).toEqual([]);
  });
});

describe('working-tree check', () => {
  it('flags an unstaged edit and nothing on a clean checkout; a touched file is not a change', async () => {
    const dir = cleanFixture('update-wt');
    const repo = await openNodeRepoAccess(dir);
    const manifest = await buildManifest(repo, config);
    expect(await checkWorkingTree(repo, manifest)).toEqual([]);

    appendFileSync(path.join(dir, 'service/main.py'), '\n# edited on disk\n');
    const later = new Date(Date.now() + 60_000);
    utimesSync(path.join(dir, 'native/main.c'), later, later); // touched, same content
    rmSync(path.join(dir, 'docs/notes.txt'));

    const flagged = await checkWorkingTree(repo, manifest, { concurrency: 3 });
    expect(flagged).toEqual(['docs/notes.txt', 'native/main.c', 'service/main.py']);
    expect(await checkWorkingTree(repo, openGitRepo(repo.git!).indexEntries())).toEqual(flagged);

    const confirmed = await confirmWorkingTree(repo, flagged, config);
    expect(confirmed.map((c) => c.path)).toEqual(['docs/notes.txt', 'service/main.py']);
    expect(confirmed[0].missing).toBe(true);
    expect(confirmed[1].oid).toBe(git(dir, ['hash-object', '--', 'service/main.py']).trim());

    const plan = planUpdate(manifest, manifest, confirmed);
    expect(plan.reparse).toEqual(['service/main.py']);
    expect(plan.drop).toEqual(['docs/notes.txt']);
    // once the map shows the content that is on disk, the same finding is no longer a change
    const shown = manifest.entries.map((e) => (e.path === 'service/main.py' ? { ...e, oid: confirmed[1].oid } : e)).filter((e) => e.path !== 'docs/notes.txt');
    expect(planUpdate(shown, manifest, confirmed).count).toBe(0);
  });
});

// ---- applyUpdate with fake passes ----

const entry = (p: string, oid: string): ManifestEntry => ({ path: p, oid, bytes: 10, lang: 'ts', read: 'pack', packOffset: 0 });
const manifestOf = (entries: ManifestEntry[]): Manifest => ({ repoName: 'fake', source: 'git', headOid: 'h'.repeat(40), indexChecksum: 'c'.repeat(40), remoteUrl: null, entries, excluded: 0, totalBytes: 0 });
const factsOf = (p: string, oid: string, loc: number): FileFacts => ({ path: p, oid, bytes: 10, lang: 'ts', loc, imports: [] });
const syntaxOf = (p: string, oid: string, name: string): SyntaxFacts => ({ path: p, oid, defs: [{ name, kind: 'function', line: 1 }], refs: [] });

function fakeState(over: Partial<PipelineState>): PipelineState {
  return {
    source: { kind: 'synthetic', files: 0 }, repo: memoryRepo('fake', { 'a.ts': 'a' }), manifest: null, facts: [], syntax: [], syntaxComplete: true,
    slowPass: null, gate: null, analysis: null, structure: 'full', settle: null, fromSnapshot: false, changedFiles: 0, history: null, saver: null, timings: {},
    ...over,
  };
}

/** Passes that record what they were asked for and answer with recognisable facts. */
function fakeLib(fresh: Manifest) {
  const scanned: ManifestEntry[] = [], parsed: ManifestEntry[] = [];
  return {
    scanned, parsed,
    buildManifest: async () => fresh,
    runFastPass: async (m: Manifest) => { scanned.push(...m.entries); return m.entries.map((e) => (e.path === 'gone.ts' ? { ...factsOf(e.path, e.oid, 0), skipped: 'unreadable' as const } : factsOf(e.path, e.oid, 99))); },
    runSlowPass: async (m: Manifest) => { parsed.push(...m.entries); return m.entries.map((e) => syntaxOf(e.path, e.oid, 'fresh')); },
  };
}

const fakeDeps = (files: { path: string; oid: string }[] = []): PipelineDeps => ({
  config,
  pool: {},
  store: { replica: { table: () => ({ slots: () => files.map((_, i) => i), ids: files.map((f) => f.path), cols: { oid: files.map((f) => f.oid), bytes: files.map(() => 10) } }) } },
} as unknown as PipelineDeps);

describe('applyUpdate', () => {
  it('re-parses only what changed, keeps untouched facts and drops removed ones', async () => {
    const state = fakeState({
      manifest: manifestOf([entry('a.ts', 'a1'), entry('b.ts', 'b1'), entry('c.ts', 'c1'), entry('e.ts', 'e1')]),
      facts: [factsOf('a.ts', 'a1', 1), factsOf('b.ts', 'b1', 2), factsOf('c.ts', 'c1', 3), factsOf('e.ts', 'e1', 5)],
      syntax: [syntaxOf('a.ts', 'a1', 'old'), syntaxOf('b.ts', 'b1', 'old'), syntaxOf('e.ts', 'e1', 'old')],
    });
    const keptFacts = state.facts[1], keptSyntax = state.syntax[1];
    // a changed, c removed, d added, e edited on disk (not staged), gone.ts tracked but deleted on disk
    const fresh = manifestOf([entry('a.ts', 'a2'), entry('b.ts', 'b1'), entry('d.ts', 'd1'), entry('e.ts', 'e1'), entry('gone.ts', 'g1')]);
    const lib = fakeLib(fresh);

    const result = await applyUpdate(fakeDeps(), state, ['e.ts', 'gone.ts'], lib);

    expect(lib.scanned.map((e) => e.path)).toEqual(['a.ts', 'd.ts', 'e.ts', 'gone.ts']);
    // a file edited on disk is read from the working tree, under no oid
    expect(lib.scanned[2]).toMatchObject({ path: 'e.ts', oid: '', read: 'tree', packOffset: -1 });
    expect(lib.scanned[0]).toMatchObject({ path: 'a.ts', oid: 'a2', read: 'pack' });

    expect(state.facts.map((f) => [f.path, f.oid, f.loc])).toEqual([['a.ts', 'a2', 99], ['b.ts', 'b1', 2], ['d.ts', 'd1', 99], ['e.ts', '', 99]]);
    expect(state.facts[1]).toBe(keptFacts);
    expect(state.syntax.map((s) => [s.path, s.oid, s.defs[0].name])).toEqual([['a.ts', 'a2', 'fresh'], ['b.ts', 'b1', 'old'], ['d.ts', 'd1', 'fresh'], ['e.ts', '', 'fresh']]);
    expect(state.syntax[1]).toBe(keptSyntax);
    expect(state.manifest!.entries.map((e) => e.path)).toEqual(['a.ts', 'b.ts', 'd.ts', 'e.ts']);
    expect(state.syntaxComplete).toBe(true);
    expect(result.dropped).toEqual(['c.ts']);
    expect(result.parsed).toEqual(['a.ts', 'd.ts', 'e.ts']);
    expect(result.kept).toBe(1);
    expect(result.meta).toEqual({ headOid: fresh.headOid, indexChecksum: fresh.indexChecksum });
  });

  it('on a return visit holds no facts, so every file goes through the passes while the plan counts only the changes', async () => {
    const state = fakeState({ fromSnapshot: true, syntaxComplete: false });
    const fresh = manifestOf([entry('a.ts', 'a2'), entry('b.ts', 'b1')]);
    const lib = fakeLib(fresh);
    const result = await applyUpdate(fakeDeps([{ path: 'a.ts', oid: 'a1' }, { path: 'b.ts', oid: 'b1' }, { path: 'c.ts', oid: 'c1' }]), state, undefined, lib);
    expect(result.plan.reparse).toEqual(['a.ts']);
    expect(result.plan.count).toBe(2);
    expect(result.dropped).toEqual(['c.ts']);
    expect(lib.scanned.map((e) => e.path)).toEqual(['a.ts', 'b.ts']);
    expect(lib.parsed.map((e) => e.path)).toEqual(['a.ts', 'b.ts']);
    expect(state.facts.map((f) => f.path)).toEqual(['a.ts', 'b.ts']);
    expect(state.syntaxComplete).toBe(true);
  });

  it('with the real passes: a staged edit comes from git, an unstaged one from disk, and the map follows', async () => {
    const dir = cleanFixture('update-apply');
    const locator: RepoLocator = { kind: 'node', rootPath: dir };
    const run = await runHeadless({ kind: 'directory', locator }, config);
    const openRepo = async () => openNodeRepoAccess(dir);
    const pool = createInlinePool({ config, tasks: allTasks, openRepo });
    try {
      const { state, store } = run;
      const before = state.facts.length;
      const untouched = state.facts.find((f) => f.path === 'service/models.py')!;

      // staged: a new file; unstaged: an edit that adds an import
      writeFileSync(path.join(dir, 'web/src/extra.ts'), "import { startApp } from './app';\nexport const extra = startApp;\n");
      git(dir, ['add', '--', 'web/src/extra.ts']);
      appendFileSync(path.join(dir, 'web/src/util/format.ts'), "\nimport { extra } from '../extra';\nexport const again = extra;\n");
      rmSync(path.join(dir, 'docs/notes.txt'));

      const deps = { config, pool, store, openRepo, emit() {}, physics: {} } as unknown as PipelineDeps;
      const result = await applyUpdate(deps, state, undefined, { checkWorkingTree: true });

      expect(result.plan.reparse).toEqual(['web/src/extra.ts', 'web/src/util/format.ts']);
      expect(result.dropped).toEqual(['docs/notes.txt']);
      expect(result.parsed).toEqual(result.plan.reparse);
      expect(state.facts.length).toBe(before);
      expect(state.facts.find((f) => f.path === 'service/models.py')).toBe(untouched);
      const format = state.facts.find((f) => f.path === 'web/src/util/format.ts')!;
      expect(format.imports.map((i) => i.spec)).toContain('../extra');
      expect(format.oid).toBe(git(dir, ['hash-object', '--', 'web/src/util/format.ts']).trim());
      expect(state.syntax.find((s) => s.path === 'web/src/util/format.ts')!.defs.map((d) => d.name)).toContain('again');

      // the hand-off to the lead's step: the same ids, the changed files in the model
      await analyzeAndApply(deps, state, { keepIds: true, extraMeta: result.meta });
      const files = store.replica.table('file');
      expect(files.has('web/src/extra.ts')).toBe(true);
      expect(files.has('docs/notes.txt')).toBe(false);
      expect(files.cols.oid[files.slotOf('web/src/util/format.ts')]).toBe(format.oid);
      // and a second look finds nothing left to do
      const again = await applyUpdate(deps, state, undefined, { checkWorkingTree: true });
      expect(again.plan.count).toBe(0);
      expect(again.parsed).toEqual([]);
    } finally {
      pool.dispose();
      run.dispose();
    }
  }, 60_000);
});
