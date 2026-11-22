// The gitignore matcher and the folder walk against git itself, on fixtures/walk: a small repo with
// layered .gitignore files. Its tracked files are all ones the rules leave alone; the ignored and
// untracked files are written here into a private copy of the built working tree.
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { config, withConfig } from '../../config';
import type { RepoAccess } from '../../contracts/git';
import { NodeGitFs, NodeWorkingTree } from '../../git/node';
import { buildFixtureRepo, git } from '../../testing/fixture';
import { MemoryGitFs, MemoryWorkingTree } from '../../testing/memory';
import { fakeGit } from '../fakeGit';
import { buildManifest } from '../manifest';
import { IgnoreMatcher, WalkLimitError, gitIgnoresCase, walkTree } from './index';

/** Files added to the built working tree: some ignored, some merely untracked. git decides which. */
const EXTRA = [
  'a.tmp', 'src/x.tmp', 'untracked.txt', 'src/app/new.ts',
  'build/out.js', 'build/.gitignore', 'src/build/x.js',
  'logs/a.txt', 'src/logs/b.txt',
  'docs/draft.pdf', 'docs/sub/other.pdf',
  'cache/x', 'src/deep/cache/y', 'cache.txt',
  'src/generated/q.ts', 'src/deep/a/generated/q.ts', 'generated/q.ts',
  'tools/readme.txt', 'tools/sub/data.bin', 'tools/sub/more/x.sh', 'tools/sub/more/x.txt',
  '#notes.txt', '!important.txt', 'trail.txt', 'with space.txt', 'notes.txt',
  'vendor/lib/dist/x.js', 'vendor/dist/x.js', 'vendor/a/b/dist/x.js',
  'obj.o', 'lib.a', 'src/deep/m.o', 'obj.oa',
  'temp1', 'temp12', 'src/temp2/f',
  'TODO', 'src/TODO',
  'makefile.local',
  'data/raw', 'data/a/raw', 'data/a/b/raw/f', 'data/a/rawx',
  'report12.txt', 'report1a.txt',
  'src/local.ts', 'src/secret/key.txt', 'src/deep/skip.ts', 'src/deep/a/b/skip.ts', 'src/skip.ts',
  'src/old.bak', 'src/app/extra.js', 'src/app/sub/inner.ts',
  'docs/a.draft.md', 'docs/drafts/kept.md', 'docs/drafts/other.md', 'docs/sub/b.draft.md',
  'local-only.txt', 'src/local-only.txt',
];
/** .git/info/exclude for the second half of the tests. The root .gitignore outranks it. */
const EXCLUDE = '# private rules\nlocal-only.txt\n!a.tmp\n/untracked.txt\n';

interface Item { path: string; dir: boolean }

let root = '';
let all: Item[] = [];

function scan(dir: string, out: Item[] = []): Item[] {
  for (const name of readdirSync(path.join(root, dir)).sort()) {
    if (name === '.git') continue;
    const rel = dir ? `${dir}/${name}` : name;
    const isDir = statSync(path.join(root, rel)).isDirectory();
    out.push({ path: rel, dir: isDir });
    if (isDir) scan(rel, out);
  }
  return out;
}

function setExclude(text: string | null): void {
  const file = path.join(root, '.git', 'info', 'exclude');
  if (text === null) rmSync(file, { force: true });
  else { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); }
}

/** git with the user's own global ignore file switched off: that file is outside the repo and out of scope. */
const gitHere = (args: string[]): string => git(root, ['-c', 'core.excludesFile=', '-c', 'core.quotePath=false', ...args]);

function gitIgnored(): Set<string> {
  return new Set(gitHere(['check-ignore', '--no-index', '--', ...all.map((e) => e.path)]).split('\n').filter(Boolean));
}

/** What git puts on the map: tracked files plus untracked files that are not ignored. */
function gitFiles(): string[] {
  const list = (args: string[]) => gitHere(['ls-files', '-z', ...args]).split('\0').filter(Boolean);
  return [...new Set([...list([]), ...list(['--others', '--exclude-standard'])])].sort();
}

function matcherFor(exclude: string | null): IgnoreMatcher {
  const m = new IgnoreMatcher({ ignoreCase: gitIgnoresCase(new NodeGitFs(path.join(root, '.git'))) });
  for (const e of all) if (!e.dir && path.posix.basename(e.path) === '.gitignore') m.add(path.posix.dirname(e.path).replace(/^\.$/, ''), readFileSync(path.join(root, e.path), 'utf8'));
  if (exclude !== null) m.addExclude(exclude);
  return m;
}

describe('against git, on fixtures/walk', () => {
  beforeAll(() => {
    root = buildFixtureRepo('walk', 'ignore');
    for (const f of EXTRA) {
      mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
      writeFileSync(path.join(root, f), f === 'build/.gitignore' ? '!out.js\n' : `${f}\n`);
    }
    setExclude(null);
    all = scan('');
  });

  it('gives every path the verdict of git check-ignore, with and without .git/info/exclude', () => {
    for (const exclude of [null, EXCLUDE]) {
      setExclude(exclude);
      const expected = gitIgnored();
      const m = matcherFor(exclude);
      const wrong = all.filter((e) => m.ignores(e.path, e.dir) !== expected.has(e.path)).map((e) => `${e.path}: git ${expected.has(e.path) ? 'ignores' : 'keeps'} it`);
      expect(wrong).toEqual([]);
      // the fixture exercises both answers, and the rule that an excluded directory cannot be reopened
      expect(expected.size).toBeGreaterThan(30);
      expect(all.length - expected.size).toBeGreaterThan(30);
      expect(expected.has('docs/drafts/kept.md')).toBe(true);
      expect(expected.has('local-only.txt')).toBe(exclude !== null);
    }
    setExclude(null);
  });

  it('walks the folder to the file list git has: tracked plus untracked-not-ignored', async () => {
    setExclude(null);
    const gitFs = new NodeGitFs(path.join(root, '.git'));
    const tree = new NodeWorkingTree(root); // lists no .git: a plain folder
    const plain = await walkTree(tree, { ignoreCase: gitIgnoresCase(gitFs) });
    const expected = gitFiles();
    expect(plain.map((f) => f.path)).toEqual(expected);
    expect(expected).toContain('local-only.txt');
    expect(expected).not.toContain('a.tmp');
    for (const f of plain.slice(0, 5)) expect(f.size).toBe(statSync(path.join(root, f.path)).size);

    // with the git directory at hand, .git/info/exclude counts too
    setExclude(EXCLUDE);
    const withGit = await walkTree(tree, { git: gitFs, sizes: false });
    const expectedWithExclude = gitFiles();
    expect(withGit.map((f) => f.path)).toEqual(expectedWithExclude);
    expect(expectedWithExclude).not.toContain('local-only.txt');
    setExclude(null);
  });
});

describe('gitignore matcher', () => {
  it('cannot re-include a file under an excluded directory', () => {
    const m = new IgnoreMatcher();
    m.add('', 'out/\n!out/keep.txt\n/gen/*\n!/gen/keep.txt\n*.log\n!important.log\n');
    expect(m.ignores('out', true)).toBe(true);
    expect(m.ignores('out/keep.txt')).toBe(true); // the directory is excluded: the negation is too late
    expect(m.ignores('gen/other.txt')).toBe(true);
    expect(m.ignores('gen/keep.txt')).toBe(false); // gen/* excludes the entries, not gen itself
    expect(m.ignores('a/debug.log')).toBe(true);
    expect(m.ignores('a/important.log')).toBe(false);
    // a nested file cannot reopen it either, and is itself ignored
    m.add('out', '!keep.txt\n');
    expect(m.ignores('out/keep.txt')).toBe(true);
  });

  it("tells 'foo/' from 'foo', and anchors a pattern that has a slash", () => {
    const m = new IgnoreMatcher();
    m.add('', 'foo/\nbar\ndoc/frotz\n/top.txt\nsrc/**/gen\n**/any/x\nabc/**\n');
    expect(m.ignores('foo', true)).toBe(true);
    expect(m.ignores('foo', false)).toBe(false);
    expect(m.ignores('a/foo', true)).toBe(true);
    expect(m.ignores('a/foo/x.ts')).toBe(true);
    expect(m.ignores('bar')).toBe(true);
    expect(m.ignores('a/b/bar', true)).toBe(true);
    expect(m.ignores('doc/frotz')).toBe(true);
    expect(m.ignores('a/doc/frotz')).toBe(false); // a middle slash anchors it to the .gitignore's folder
    expect(m.ignores('top.txt')).toBe(true);
    expect(m.ignores('a/top.txt')).toBe(false);
    expect(m.ignores('src/gen')).toBe(true); // "/**/" matches no directory at all
    expect(m.ignores('src/a/b/gen')).toBe(true);
    expect(m.ignores('lib/src/gen')).toBe(false);
    expect(m.ignores('any/x')).toBe(true);
    expect(m.ignores('p/q/any/x')).toBe(true);
    expect(m.ignores('abc', true)).toBe(false); // "abc/**" is everything inside, not abc itself
    expect(m.ignores('abc/d/e')).toBe(true);
  });

  it('lets a nested .gitignore override its parents, inside its own folder only', () => {
    const m = new IgnoreMatcher();
    m.add('', '*.tmp\n\\#hash\n\\!bang\nspace.txt   \n');
    m.add('pkg', '!*.tmp\n/only-here.ts\n');
    expect(m.ignores('a.tmp')).toBe(true);
    expect(m.ignores('pkg/a.tmp')).toBe(false);
    expect(m.ignores('pkg/deep/a.tmp')).toBe(false);
    expect(m.ignores('other/a.tmp')).toBe(true);
    expect(m.ignores('pkg/only-here.ts')).toBe(true);
    expect(m.ignores('pkg/deep/only-here.ts')).toBe(false);
    expect(m.ignores('only-here.ts')).toBe(false);
    expect(m.ignores('#hash')).toBe(true);
    expect(m.ignores('!bang')).toBe(true);
    expect(m.ignores('space.txt')).toBe(true);
    expect(new IgnoreMatcher({ ignoreCase: true }).ignores('x')).toBe(false);
    const folded = new IgnoreMatcher({ ignoreCase: true });
    folded.add('', 'Thumbs.db\n*.BAK\n');
    expect(folded.ignores('a/thumbs.DB')).toBe(true);
    expect(folded.ignores('old.bak')).toBe(true);
    expect(m.ignores('SPACE.txt')).toBe(false);
  });
});

describe('walkTree', () => {
  const files: Record<string, string> = {
    '.gitignore': 'skip/\n',
    'a.ts': 'a', 'lib/b.ts': 'bb', 'lib/deep/c.ts': 'ccc',
    'skip/d.ts': 'never listed', '.git/config': '[core]', 'lib/.git/HEAD': 'a nested repository',
  };

  it('prunes ignored folders without listing them, and never enters .git', async () => {
    const listed: string[] = [];
    const tree = new MemoryWorkingTree(files);
    const list = tree.list.bind(tree);
    tree.list = (dir) => { listed.push(dir); return list(dir); };
    expect(await walkTree(tree)).toEqual([{ path: '.gitignore', size: 6 }, { path: 'a.ts', size: 1 }, { path: 'lib/b.ts', size: 2 }, { path: 'lib/deep/c.ts', size: 3 }]);
    expect(listed.sort()).toEqual(['', 'lib', 'lib/deep']);
    // a folder with a .git of its own is opaque when the caller asks for git's view
    expect((await walkTree(tree, { skipNestedRepos: true, sizes: false })).map((f) => f.path)).toEqual(['.gitignore', 'a.ts']);
  });

  it('stops with a clear error at the file cap, and when the signal aborts', async () => {
    const tree = new MemoryWorkingTree(files);
    await expect(walkTree(tree, { maxFiles: 2 })).rejects.toBeInstanceOf(WalkLimitError);
    expect((await walkTree(tree, { maxFiles: 4 })).length).toBe(4);
    const aborter = new AbortController();
    const list = tree.list.bind(tree);
    tree.list = (dir) => { if (dir === 'lib') aborter.abort(); return list(dir); };
    await expect(walkTree(tree, { signal: aborter.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('buildManifest with parser.includeUntracked', () => {
  it('adds untracked files that are not ignored to the tracked ones', async () => {
    const fake = fakeGit([
      { path: 'src/a.ts', text: 'export const a = 1;\n' },
      { path: 'forced.tmp', text: 'tracked although a rule ignores it' },
      { path: 'link', text: 'src/a.ts', mode: 0o120000 },
    ]);
    (fake.fs as MemoryGitFs).files['info/exclude'] = new TextEncoder().encode('local.txt\n');
    const tree = new MemoryWorkingTree({
      '.gitignore': '*.tmp\nbuild/\n',
      'src/a.ts': 'export const a = 1;\n',
      'src/new.ts': 'export const fresh = 2;\n',
      'forced.tmp': 'tracked although a rule ignores it',
      'link': 'src/a.ts',
      'scratch.tmp': 'ignored',
      'build/out.js': 'ignored with its folder',
      'local.txt': 'ignored by .git/info/exclude',
      'notes.txt': 'untracked',
      'logo.png': 'untracked, binary by extension',
      '.github/ci.yml': 'on: push\n',
      'web/dist/bundle.js': 'dropped by config.parser.exclude',
      'sub/.git': 'gitdir: elsewhere',
      'sub/x.ts': 'inside another repository',
    });
    const repo: RepoAccess = { name: 'mixed', tree, git: fake.fs };

    const off = await buildManifest(repo, config, () => fake.repo);
    expect(off.entries.map((e) => e.path)).toEqual(['forced.tmp', 'src/a.ts']);

    const on = await buildManifest(repo, withConfig({ parser: { includeUntracked: true } }), () => fake.repo);
    expect(on.source).toBe('git');
    expect(on.headOid).toBe(off.headOid);
    expect(on.excluded).toBe(off.excluded);
    expect(on.entries.map((e) => e.path)).toEqual(['.github/ci.yml', '.gitignore', 'forced.tmp', 'logo.png', 'notes.txt', 'src/a.ts', 'src/new.ts']);
    const by = Object.fromEntries(on.entries.map((e) => [e.path, e]));
    expect(by['src/new.ts']).toMatchObject({ oid: '', read: 'tree', lang: 'ts', packOffset: -1, bytes: 24 });
    expect(by['src/a.ts']).toMatchObject({ oid: fake.oidOf('src/a.ts'), read: 'pack' });
    expect(by['logo.png']).toMatchObject({ oid: '', read: 'none' });
    expect(on.totalBytes).toBe(on.entries.reduce((s, e) => s + e.bytes, 0));
  });

  it('honours .gitignore in a plain folder', async () => {
    const repo: RepoAccess = { name: 'plain', git: null, tree: new MemoryWorkingTree({ '.gitignore': '/out/\n*.tmp\n', 'a.ts': 'x', 'b.tmp': 'x', 'out/c.ts': 'x', 'src/out/d.ts': 'x' }) };
    const m = await buildManifest(repo, config);
    expect(m.source).toBe('folder');
    expect(m.entries.map((e) => e.path)).toEqual(['.gitignore', 'a.ts', 'src/out/d.ts']);
  });
});
