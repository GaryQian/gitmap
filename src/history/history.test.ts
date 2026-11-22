// The walk must agree with git itself: every table here is compared against `git log`.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInlinePool } from '../compute';
import { config, withConfig } from '../config';
import type { ComputePool } from '../contracts/compute';
import { openGitRepo, parseCommit } from '../git';
import { NodeGitFs, openNodeRepoAccess } from '../git/node';
import type { HistoryInput } from '../overlays';
import { buildFixtureRepo, fixtureExpected, git, projectRoot } from '../testing/fixture';
import { CommitGraph } from './commitGraph';
import {
  historyChunkTask, historyFromJson, historyPlanTask, historyToJson, parseMailmap, runHistoryWalk,
  type HistoryOutcome, type HistoryResult, type HistoryWalkOptions, type MergeMode,
} from './index';

type Walked = Extract<HistoryOutcome, { available: true }>;

const opened: NodeGitFs[] = [];
const scratch: string[] = [];
afterAll(() => {
  for (const fs of opened) fs.close();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** Small chunks and several simulated workers, so results are merged from many chunks. */
const smallChunks = withConfig({ scheduler: { historyChunkCommits: 2 } });

async function poolFor(dir: string, size = 3): Promise<ComputePool> {
  const pool = createInlinePool({
    config: smallChunks, size, tasks: [historyPlanTask, historyChunkTask],
    openRepo: async (locator) => {
      const access = await openNodeRepoAccess((locator as { rootPath: string }).rootPath);
      if (access.git) opened.push(access.git as NodeGitFs);
      return access;
    },
  });
  await pool.setRepo({ kind: 'node', rootPath: dir });
  return pool;
}

/** One walk with one-commit planner pages, so every walk crosses page and chunk boundaries. */
function run(pool: ComputePool, opts: HistoryWalkOptions = {}, cfg = smallChunks): Promise<HistoryOutcome> {
  return runHistoryWalk(pool, cfg, { planPageCommits: 1, ...opts });
}

async function walk(pool: ComputePool, opts: HistoryWalkOptions = {}, cfg = smallChunks): Promise<HistoryResult> {
  const outcome = await run(pool, opts, cfg);
  if (!outcome.available) throw new Error(`history unavailable: ${outcome.reason}`);
  return outcome.result;
}

interface Row { commits: number; last: number; first: number; authors: Record<string, number> }
interface Table { files: Record<string, Row>; contributors: Record<string, { name: string; commits: number }> }

const LOG_ARGS: Record<MergeMode, string[]> = {
  skip: ['--no-merges'],
  include: ['--diff-merges=first-parent'],
  firstParent: ['--first-parent', '--diff-merges=first-parent'],
};

/** The same facts from git: one record per commit with the paths it touched, authors through .mailmap. */
function gitTable(dir: string, merges: MergeMode, rev = 'HEAD'): Table {
  const out = git(dir, ['-c', 'core.quotepath=off', 'log', '--no-renames', ...LOG_ARGS[merges], '--name-only', '--format=%x01%H%x09%at%x09%aN%x09%aE', rev]);
  const t: Table = { files: {}, contributors: {} };
  const newest: Record<string, number> = {};
  for (const block of out.split('\x01').slice(1)) {
    const [head, ...rest] = block.split('\n');
    const [, at, name, email] = head.split('\t');
    const time = Number(at);
    const key = email.toLowerCase();
    const c = (t.contributors[key] ??= { name, commits: 0 });
    c.commits++;
    if (!(key in newest) || time > newest[key]) { newest[key] = time; c.name = name; }
    for (const file of rest.filter(Boolean)) {
      const row = (t.files[file] ??= { commits: 0, last: -Infinity, first: Infinity, authors: {} });
      row.commits++;
      row.last = Math.max(row.last, time);
      row.first = Math.min(row.first, time);
      row.authors[key] = (row.authors[key] ?? 0) + 1;
    }
  }
  return t;
}

function tableOf(r: HistoryResult): Table {
  const files: Table['files'] = {};
  for (const [p, f] of r.files) {
    const authors: Row['authors'] = {};
    for (const [who, n] of f.authors) authors[r.contributors[who].emails[0]] = n;
    files[p] = { commits: f.commits, last: f.lastModified, first: f.firstSeen, authors };
  }
  const contributors: Table['contributors'] = {};
  for (const c of r.contributors) contributors[c.emails[0]] = { name: c.name, commits: c.commits };
  return { files, contributors };
}

const lines = (text: string): string[] => text.split('\n').filter(Boolean);
const lsFiles = (dir: string): string[] => lines(git(dir, ['-c', 'core.quotepath=off', 'ls-files']));

/** A throwaway folder under .fixtures/, named per process so parallel test runs do not collide. */
function scratchDir(name: string): string {
  const dir = path.join(projectRoot(), '.fixtures', `history-${name}-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  scratch.push(dir);
  return dir;
}

interface Step {
  /** Branch the commit goes on. */
  on: string;
  who: string;
  email: string;
  /** Day of January 2024: author and commit date. */
  day: number;
  message: string;
  /** Marks of the parents, first parent first. None for the root commit. */
  parents?: number[];
  files?: Record<string, string>;
  remove?: string[];
}

/** Write commits with `git fast-import`: one process for the whole history. Commit n gets mark n (1-based). */
function fastImport(dir: string, steps: Step[]): void {
  const data = (text: string): string => `data ${Buffer.byteLength(text)}\n${text}\n`;
  let stream = '';
  steps.forEach((s, i) => {
    const when = `${Date.UTC(2024, 0, s.day, 10) / 1000} +0000`;
    stream += `commit refs/heads/${s.on}\nmark :${i + 1}\nauthor ${s.who} <${s.email}> ${when}\ncommitter ${s.who} <${s.email}> ${when}\n${data(s.message)}`;
    (s.parents ?? []).forEach((p, k) => { stream += `${k === 0 ? 'from' : 'merge'} :${p}\n`; });
    for (const [file, text] of Object.entries(s.files ?? {})) stream += `M 100644 inline ${file}\n${data(text)}`;
    for (const file of s.remove ?? []) stream += `D ${file}\n`;
    stream += '\n';
  });
  execFileSync('git', ['fast-import', '--quiet'], { cwd: dir, input: stream, stdio: ['pipe', 'ignore', 'pipe'] });
}

/**
 * main:  c1 - c2 - c3 - M1 - c4 - M2 (octopus) - c5
 *         \- f1 --------/      |- x1 -|
 *                              \- y1 -/
 * f1 and c3 share a commit date. Linus commits under two addresses and Grace under two names,
 * which the .mailmap in the working tree folds together. Objects are packed; nothing is checked out.
 */
function buildMergeRepo(): string {
  const dir = scratchDir('merge');
  git(dir, ['init', '-q', '-b', 'main']);
  const ada = { who: 'Ada Lovelace', email: 'ada@example.com' };
  const grace = { who: 'grace', email: 'grace@example.com' };
  const linus = { who: 'Linus Torvalds', email: 'linus@example.com' };
  fastImport(dir, [
    /* 1 */ { on: 'main', ...ada, day: 1, message: 'c1', files: { 'a.txt': 'a1\n', 'b.txt': 'b1\n', 'dir/c.txt': 'c1\n' } },
    /* 2 */ { on: 'main', ...grace, day: 2, message: 'c2', parents: [1], files: { 'a.txt': 'a2\n' } },
    /* 3 */ { on: 'feature', who: 'linus', email: 'Linus@OLD.example.com', day: 3, message: 'f1', parents: [1], files: { 'dir/d.txt': 'd1\n', 'b.txt': 'b2\n' } },
    /* 4 */ { on: 'main', ...ada, day: 3, message: 'c3', parents: [2], files: { 'dir/c.txt': 'c2\n' } },
    // a merge lists what its branch brought in, as its tree starts from the first parent's
    /* 5 */ { on: 'main', who: 'Grace Hopper', email: 'grace@example.com', day: 4, message: 'M1', parents: [4, 3], files: { 'dir/d.txt': 'd1\n', 'b.txt': 'b2\n' } },
    /* 6 */ { on: 'main', ...linus, day: 5, message: 'c4', parents: [5], files: { 'a.txt': 'a3\n' }, remove: ['b.txt'] },
    /* 7 */ { on: 'x', ...ada, day: 6, message: 'x1', parents: [6], files: { 'x.txt': 'x1\n' } },
    /* 8 */ { on: 'y', ...ada, day: 7, message: 'y1', parents: [6], files: { 'y.txt': 'y1\n' } },
    /* 9 */ { on: 'main', ...grace, day: 8, message: 'M2', parents: [6, 7, 8], files: { 'x.txt': 'x1\n', 'y.txt': 'y1\n' } },
    /* 10 */ { on: 'main', ...ada, day: 9, message: 'c5', parents: [9], files: { 'x.txt': 'x2\n' } },
  ]);
  writeFileSync(path.join(dir, '.mailmap'), [
    '# canonical identities',
    'Linus Torvalds <linus@example.com> <linus@old.example.com>',
    'Grace B. Hopper <grace@example.com>',
    '',
  ].join('\n'));
  return dir;
}

describe('history walk on the three-lang fixture', () => {
  const dir = buildFixtureRepo('three-lang');
  let pool: ComputePool;
  beforeAll(async () => { pool = await poolFor(dir); });
  afterAll(() => pool.dispose());
  const expected = fixtureExpected<{ history: { commits: number; authors: Record<string, number>; perFile: Record<string, { commits: number; lastAuthor: string; lastDate: string }> } }>('three-lang').history;

  it('gives the per-file facts and contributor totals the fixture expects', async () => {
    const reports: number[] = [];
    const r = await walk(pool, { paths: lsFiles(dir), progressIntervalMs: 0, onProgress: (_p, info) => reports.push(info.commitsWalked) });
    expect(r.commitsWalked).toBe(expected.commits);
    expect(r).toMatchObject({ complete: true, recencyComplete: true, headOid: git(dir, ['rev-parse', 'HEAD']).trim() });
    expect(r.reachedOid).toBe(git(dir, ['rev-list', '--max-parents=0', 'HEAD']).trim());
    for (const [file, want] of Object.entries(expected.perFile)) {
      const f = r.files.get(file)!;
      expect(f.commits, file).toBe(want.commits);
      expect(r.contributors[f.lastAuthor].name, file).toBe(want.lastAuthor);
      expect(new Date(f.lastModified * 1000).toISOString(), file).toBe(new Date(want.lastDate).toISOString());
    }
    expect(Object.fromEntries(r.contributors.map((c) => [c.name, c.commits]))).toEqual(expected.authors);
    // a result is the layer builders' input as it stands: no copying adapter is needed
    const input: HistoryInput = { contributors: r.contributors, files: r.files, coverage: 1, complete: r.complete, recencyComplete: r.recencyComplete, now: 0 };
    expect(input.contributors.map((c) => c.id)).toEqual(r.contributors.map((_, i) => i));
    // progress never goes backwards and ends with the final result
    expect(reports.length).toBeGreaterThan(1);
    expect([...reports].sort((a, b) => a - b)).toEqual(reports);
    expect(reports.at(-1)).toBe(expected.commits);
  });

  it('equals git log for every path, with and without the list of current files', async () => {
    const ref = gitTable(dir, 'skip');
    expect(tableOf(await walk(pool))).toEqual(ref);
    const current = lsFiles(dir);
    const kept = await walk(pool, { paths: current }, config);
    expect(tableOf(kept).files).toEqual(Object.fromEntries(current.map((p) => [p, ref.files[p]])));
  });

  it('an incremental walk from a saved result equals a full walk', async () => {
    const paths = lsFiles(dir);
    const full = await walk(pool, { paths });
    for (const back of [1, 2, 4]) {
      const older = await walk(pool, { paths, startOid: git(dir, ['rev-parse', `HEAD~${back}`]).trim() });
      expect(older.commitsWalked).toBe(expected.commits - back);
      // through the snapshot form, as on a return visit
      const saved = historyFromJson(JSON.parse(JSON.stringify(historyToJson(older))));
      const outcome = await run(pool, { paths, since: saved }) as Walked;
      expect(outcome.stats.incremental).toBe(true);
      expect(outcome.stats.chunks).toBe(Math.ceil(back / smallChunks.scheduler.historyChunkCommits));
      expect(historyToJson(outcome.result)).toEqual(historyToJson(full));
    }
  });

  it('stops at the commit cap, "load full history" lifts it, and an abort ends the walk', async () => {
    const paths = lsFiles(dir);
    const capped = await walk(pool, { paths, maxCommits: 2 });
    expect(capped).toMatchObject({ commitsWalked: 2, complete: false, recencyComplete: false, stoppedBy: 'maxCommits' });
    const newestTwo = gitTable(dir, 'skip', 'HEAD~2..HEAD').files;
    expect(tableOf(capped).files).toEqual(Object.fromEntries(paths.filter((p) => newestTwo[p]).map((p) => [p, newestTwo[p]])));
    const full = await walk(pool, { paths, maxCommits: 2, loadFull: true, since: capped });
    expect(full).toMatchObject({ commitsWalked: expected.commits, complete: true });
    const aborted = await walk(pool, { paths, signal: AbortSignal.abort() });
    expect(aborted).toMatchObject({ complete: false, stoppedBy: 'aborted', commitsWalked: 0 });
  });
});

describe('history walk with merges, ties and a mailmap', () => {
  it('follows history.merges, equals git log in each mode, when resumed from older heads, and with a commit-graph', async () => {
    const dir = buildMergeRepo();
    const pool = await poolFor(dir);
    const byMessage = Object.fromEntries(lines(git(dir, ['log', '--format=%s %H', 'HEAD'])).map((l) => l.split(' ')));
    const commits = Object.values<string>(byMessage);
    const mainline = lines(git(dir, ['rev-list', '--first-parent', 'HEAD']));
    // old heads to resume from: every commit under the default setting, the awkward ones otherwise
    // (a side branch sharing a date with the mainline, both merges, a plain mainline commit)
    const awkward = ['f1', 'M1', 'x1', 'M2', 'c2'].map((m) => byMessage[m]);
    const full = {} as Record<MergeMode, HistoryResult>;
    for (const merges of ['skip', 'include', 'firstParent'] as const) {
      const r = (full[merges] = await walk(pool, { merges, useCommitGraph: false }));
      expect(tableOf(r), merges).toEqual(gitTable(dir, merges));
      expect(r.commitsWalked, merges).toBe(merges === 'firstParent' ? mainline.length : commits.length);
      expect(r.complete).toBe(true);
      for (const from of merges === 'skip' ? commits : awkward) {
        const saved = await walk(pool, { merges, startOid: from, useCommitGraph: false, planPageCommits: undefined });
        const again = await run(pool, { merges, since: saved, useCommitGraph: false }) as Walked;
        expect(historyToJson(again.result), `${merges} since ${from}`).toEqual(historyToJson(r));
        // the saved result is reused whenever its head is behind the new one (on the mainline, for firstParent)
        expect(again.stats.incremental, `${merges} since ${from}`).toBe(merges !== 'firstParent' || mainline.includes(from));
      }
    }
    // the default is to skip merges: nothing is credited to M1, and both names of Grace are one contributor
    expect(config.history.merges).toBe('skip');
    expect(full.skip.files.get('dir/d.txt')!.commits).toBe(1);
    expect(full.include.files.get('dir/d.txt')!.commits).toBe(2);
    expect(full.skip.contributors.map((c) => c.name).sort()).toEqual(['Ada Lovelace', 'Grace B. Hopper', 'Linus Torvalds']);
    expect(full.skip.contributors.find((c) => c.name === 'Linus Torvalds')!.emails).toEqual(['linus@example.com', 'linus@old.example.com']);

    // a saved result made under another .mailmap is not extended: the walk starts over
    const before = await walk(pool, { startOid: byMessage.c4, useCommitGraph: false });
    const stale = await run(pool, { since: { ...before, mailmapHash: 'other' }, useCommitGraph: false }) as Walked;
    expect(stale.stats.incremental).toBe(false);
    expect(historyToJson(stale.result)).toEqual(historyToJson(full.skip));

    // the commit-graph must describe every commit exactly as the commit objects do, octopus merge included
    git(dir, ['commit-graph', 'write', '--reachable']);
    const fs = new NodeGitFs(path.join(dir, '.git'));
    opened.push(fs);
    const graph = CommitGraph.open(fs)!;
    const repo = openGitRepo(fs);
    expect(graph.count).toBe(commits.length);
    for (const oid of commits) {
      const c = parseCommit(repo.readObject(oid)!.data);
      expect(graph.lookup(oid)).toEqual({ tree: c.tree, parents: c.parents, date: c.committer.time });
    }
    pool.dispose();
    const fresh = await poolFor(dir); // workers look for the commit-graph once, when they first plan
    for (const merges of ['skip', 'include', 'firstParent'] as const) {
      const outcome = await run(fresh, { merges, planPageCommits: 3 }) as Walked;
      expect(outcome.stats.usedCommitGraph).toBe(true);
      expect(historyToJson(outcome.result), merges).toEqual(historyToJson(full[merges]));
    }
    fresh.dispose();
  }, 120_000);

  it('parses the four .mailmap forms', () => {
    const map = parseMailmap([
      'Proper One <one@x.org>',
      '<two@proper.org> <two@x.org>',
      'Proper Three <three@proper.org> <three@x.org>',
      'Proper Four <four@proper.org> Old Four <shared@x.org>',
    ].join('\n'))!;
    expect(map.resolve('one', 'ONE@x.org')).toEqual({ name: 'Proper One', email: 'ONE@x.org' });
    expect(map.resolve('two', 'two@x.org')).toEqual({ name: 'two', email: 'two@proper.org' });
    expect(map.resolve('3', 'three@x.org')).toEqual({ name: 'Proper Three', email: 'three@proper.org' });
    expect(map.resolve('old four', 'shared@x.org')).toEqual({ name: 'Proper Four', email: 'four@proper.org' });
    expect(map.resolve('Someone Else', 'shared@x.org')).toEqual({ name: 'Someone Else', email: 'shared@x.org' });
    expect(parseMailmap('# nothing here\n')).toBeNull();
  });
});

describe('repositories without a full history', () => {
  it('reports a plain folder and an empty repo as unavailable, and walks what a shallow clone has', async () => {
    const plain = scratchDir('plain');
    writeFileSync(path.join(plain, 'a.txt'), 'a\n');
    const outcomeOf = async (dir: string): Promise<HistoryOutcome> => {
      const pool = await poolFor(dir, 1);
      try { return await run(pool); } finally { pool.dispose(); }
    };
    expect(await outcomeOf(plain)).toMatchObject({ available: false, reason: 'no-git' });

    const empty = scratchDir('empty');
    git(empty, ['init', '-q', '-b', 'main']);
    expect(await outcomeOf(empty)).toMatchObject({ available: false, reason: 'empty' });

    const source = buildFixtureRepo('three-lang');
    const shallow = scratchDir('shallow');
    git(path.dirname(shallow), ['clone', '-q', '--no-local', '--depth', '2', source, shallow]);
    const outcome = await outcomeOf(shallow) as Walked;
    expect(outcome.result).toMatchObject({ commitsWalked: 2, complete: false, stoppedBy: 'shallow' });
    // the boundary commit has no parent on disk, so it is not credited with the whole tree
    expect(tableOf(outcome.result).files).toEqual(gitTable(source, 'skip', 'HEAD~1..HEAD').files);
  }, 120_000);
});
