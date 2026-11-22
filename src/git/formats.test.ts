// More shapes of the index, refs, config and object formats, each checked against the git binary.
// Repos that a test edits are built from scratch under .fixtures/git-x-<name>, so a run never
// depends on what an earlier run left behind.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildFixtureRepo, git, projectRoot } from '../testing/fixture';
import { MemoryGitFs } from '../testing/memory';
import {
  MODE_EXEC, MODE_FILE, MODE_GITLINK, MODE_SYMLINK, MODE_TREE,
  normalizeRemoteUrl, openGitRepo, parseCommit, parseGitConfig, parseGitIndex, parseTag, parseTree, sha1, toHex,
  UnsupportedIndexError, type GitRepository,
} from './index';
import { NodeGitFs } from './node';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const EMPTY_BLOB = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';

// Every git call costs a process start (slow on Windows), so each test makes a handful at most:
// repos are scripted through one `git fast-import` or `git update-index --index-info` stream.
function freshRepo(name: string, initArgs: string[] = []): string {
  const dir = path.join(projectRoot(), '.fixtures', `git-x-${name}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main', ...initArgs]);
  return dir;
}
/** Like git(), with text on standard input. */
function gitIn(dir: string, args: string[], input: string): string {
  return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'gc.auto=0', ...args], {
    cwd: dir, input, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' }, maxBuffer: 1 << 26, stdio: ['pipe', 'pipe', 'pipe'],
  }).toString('utf8');
}
/** A `data` command of a fast-import stream. */
const data = (text: string): string => `data ${Buffer.byteLength(text)}\n${text}\n`;
function write(dir: string, file: string, text: string): void {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), text);
}
function withRepo<T>(dir: string, fn: (repo: GitRepository) => T): T {
  const fs = new NodeGitFs(path.join(dir, '.git'));
  try { return fn(openGitRepo(fs)); } finally { fs.close(); }
}
/** `git ls-files -s` as [mode, oid, stage, path] rows. */
function lsStaged(dir: string): [string, string, string, string][] {
  return git(dir, ['-c', 'core.quotepath=off', 'ls-files', '-s']).split('\n').filter(Boolean).map((line) => {
    const [meta, file] = line.split('\t');
    const [mode, oid, stage] = meta.split(' ');
    return [mode, oid, stage, file];
  });
}
/** `git show-ref --head` as name → oid (HEAD included). */
function showRef(dir: string): Map<string, string> {
  return new Map(git(dir, ['show-ref', '--head']).split('\n').filter(Boolean).map((l) => l.split(' ').reverse() as [string, string]));
}
const readIndex = (dir: string): Uint8Array => new Uint8Array(readFileSync(path.join(dir, '.git', 'index')));
const indexVersion = (buf: Uint8Array): number => new DataView(buf.buffer, buf.byteOffset).getUint32(4);
const parsedRows = (buf: Uint8Array): [string, string, string][] => parseGitIndex(buf).map((e) => [e.mode.toString(8), e.oid, e.path]);
function reasonOf(fn: () => unknown): string {
  try { fn(); } catch (e) {
    expect(e).toBeInstanceOf(UnsupportedIndexError);
    return (e as UnsupportedIndexError).reason;
  }
  return 'no error';
}

describe('index: shapes the fixture does not have', () => {
  it('v3 (extended flags from intent-to-add and skip-worktree) equals git ls-files -s', () => {
    const dir = freshRepo('index-v3');
    write(dir, 'a.txt', 'a\n');
    write(dir, 'sub/b.txt', 'b\n');
    write(dir, 'sub/later.txt', 'not staged yet\n');
    git(dir, ['update-index', '--add', 'a.txt', 'sub/b.txt', '--skip-worktree', 'a.txt']);
    git(dir, ['add', '-N', 'sub/later.txt']);
    const buf = readIndex(dir);
    expect(indexVersion(buf)).toBe(3);
    const rows = parsedRows(buf);
    expect(rows).toEqual(lsStaged(dir).map(([mode, oid, , file]) => [mode, oid, file]));
    expect(rows.map((r) => r[2])).toEqual(['a.txt', 'sub/b.txt', 'sub/later.txt']);
  });

  it('a path of 4,095 bytes or more (the length does not fit the flags) reads in v2 and in v4', () => {
    const dir = freshRepo('index-long');
    const seg = 'segment-of-a-long-path';
    const long = (n: number, leaf: string): string => Array.from({ length: n }, (_, i) => `${seg}${i % 7}`).join('/') + '/' + leaf;
    // one just under the 0xfff limit, two over it that share a long prefix (v4 compresses against it)
    const paths = [long(150, 'short.txt'), long(250, 'x.txt'), long(250, 'y.txt'), 'zz.txt'];
    expect(enc(paths[0]).length).toBeLessThan(0xfff);
    expect(enc(paths[1]).length).toBeGreaterThan(0xfff);
    gitIn(dir, ['update-index', '--index-info'], paths.map((p) => `100644 ${EMPTY_BLOB} 0\t${p}\n`).join(''));
    const v2 = readIndex(dir);
    git(dir, ['update-index', '--index-version', '4']);
    const v4 = readIndex(dir);
    expect([indexVersion(v2), indexVersion(v4)]).toEqual([2, 4]);
    const expected = lsStaged(dir).map(([mode, o, , file]) => [mode, o, file]);
    expect(expected.map((r) => r[2]).sort()).toEqual([...paths].sort());
    expect(parsedRows(v2)).toEqual(expected);
    expect(parsedRows(v4)).toEqual(expected);
  });

  it('conflict stages yield one entry per path: "ours" when present, then "theirs", then the ancestor', () => {
    const dir = freshRepo('index-conflict');
    // stage 1 = common ancestor, 2 = ours, 3 = theirs; the oid says which stage an entry came from
    const oidOf = (stage: number): string => ['a0', 'b1', 'c2', 'd3'][stage].repeat(20);
    const shapes: Record<string, number[]> = {
      'a-clean.txt': [0], 'b-all.txt': [1, 2, 3], 'c-deleted-by-us.txt': [1, 3], 'd-deleted-by-them.txt': [1, 2],
      'e-added-by-both.txt': [2, 3], 'f-ancestor-only.txt': [1], 'g-ours-only.txt': [2], 'h-theirs-only.txt': [3],
      'i/clean.txt': [0], 'i/conflict.txt': [1, 2, 3], 'z-clean.txt': [0],
    };
    const lines = Object.entries(shapes).flatMap(([file, stages]) => stages.map((s) => `100644 ${oidOf(s)} ${s}\t${file}\n`));
    gitIn(dir, ['update-index', '--index-info'], lines.join(''));
    const staged = lsStaged(dir);
    expect(staged.length).toBe(lines.length); // git kept every stage

    const entries = parseGitIndex(readIndex(dir));
    expect(entries.map((e) => e.path)).toEqual(Object.keys(shapes));
    for (const e of entries) {
      const stages = shapes[e.path];
      const want = stages.includes(0) ? 0 : stages.includes(2) ? 2 : stages.includes(3) ? 3 : 1;
      expect(e.oid, e.path).toBe(oidOf(want));
    }
  });

  it('a damaged or unknown index is reported with a reason, never returned as a different file list', () => {
    const buf = readIndex(buildFixtureRepo('three-lang'));
    const full = parseGitIndex(buf);
    expect(full.length).toBeGreaterThan(10);

    expect(reasonOf(() => parseGitIndex(new Uint8Array(0)))).toBe('malformed');
    const badSignature = buf.slice();
    badSignature[0] = 0x58;
    expect(reasonOf(() => parseGitIndex(badSignature))).toBe('malformed');
    for (const version of [0, 1, 5, 0x01000000]) {
      const other = buf.slice();
      new DataView(other.buffer).setUint32(4, version);
      expect(reasonOf(() => parseGitIndex(other)), `version ${version}`).toBe('version');
    }
    const moreEntries = buf.slice();
    new DataView(moreEntries.buffer).setUint32(8, full.length + 1000);
    expect(reasonOf(() => parseGitIndex(moreEntries))).toBe('malformed');

    // every truncation: either all the entries were still there, or the damage is reported
    let reported = 0;
    for (let cut = 1; cut <= buf.length; cut++) {
      let got: unknown;
      try { got = parseGitIndex(buf.subarray(0, buf.length - cut)); } catch (e) {
        expect(e, `cut ${cut}`).toBeInstanceOf(UnsupportedIndexError);
        expect((e as UnsupportedIndexError).reason).toBe('malformed');
        reported++;
        continue;
      }
      expect(got, `cut ${cut}`).toEqual(full);
    }
    expect(reported).toBeGreaterThan(buf.length / 2);
  });

  it('a SHA-256 repository is refused instead of being read with 20-byte ids', () => {
    const dir = freshRepo('index-sha256', ['--object-format=sha256']);
    write(dir, 'a.txt', 'a\n');
    write(dir, 'b.txt', 'b\n');
    git(dir, ['add', '-A']);
    withRepo(dir, (repo) => {
      expect(reasonOf(() => repo.indexEntries())).toBe('sha256');
    });
  });

  it('index checksum: the trailer, or the SHA-1 git would have written when index.skipHash zeroed it', () => {
    const buf = readIndex(buildFixtureRepo('three-lang'));
    const trailer = toHex(buf, buf.length - 20);
    const zeroed = buf.slice();
    zeroed.fill(0, zeroed.length - 20);
    expect(openGitRepo(new MemoryGitFs({ index: buf })).indexChecksum()).toBe(trailer);
    expect(openGitRepo(new MemoryGitFs({ index: zeroed })).indexChecksum()).toBe(trailer);
    expect(toHex(sha1(buf.subarray(0, buf.length - 20)))).toBe(trailer);
    expect(openGitRepo(new MemoryGitFs({})).indexChecksum()).toBe('');
    // the zeroed trailer does not change what the entries are
    expect(parseGitIndex(zeroed)).toEqual(parseGitIndex(buf));
  });
});

describe('refs', () => {
  it('unborn branch, loose refs, packed-refs, tags, symbolic refs and a detached HEAD resolve to what git reports', () => {
    const dir = freshRepo('refs');
    withRepo(dir, (repo) => {
      // nothing committed yet: HEAD names a branch that does not exist, and there is no index
      expect(repo.head()).toEqual({ oid: null, ref: 'refs/heads/main' });
      expect(repo.indexEntries()).toEqual([]);
      expect(repo.indexChecksum()).toBe('');
      expect(repo.readObject(EMPTY_BLOB)).toBeNull();
      expect(repo.isShallow()).toBe(false);
    });
    const who = 'Tester <tester@example.com>';
    gitIn(dir, ['fast-import', '--quiet'], [
      `commit refs/heads/main\nmark :1\nauthor ${who} 1706745600 +0000\ncommitter ${who} 1706745600 +0000\n${data('one')}M 100644 inline a.txt\n${data('1\n')}`,
      `commit refs/heads/main\nmark :2\nauthor ${who} 1706745660 +0000\ncommitter ${who} 1706745660 +0000\n${data('two')}from :1\nM 100644 inline a.txt\n${data('2\n')}`,
      'reset refs/heads/side\nfrom :1\n',
      'reset refs/tags/light\nfrom :1\n',
      `tag v1\nfrom :1\ntagger ${who} 1706832000 +0530\n${data('release one\n\nwith a body\n')}`,
      'reset refs/remotes/origin/main\nfrom :2\n',
    ].join(''));
    writeFileSync(path.join(dir, '.git', 'refs', 'heads', 'alias'), 'ref: refs/heads/main\n'); // what `git symbolic-ref` writes

    const expectRefs = (): Map<string, string> => {
      const refs = showRef(dir);
      withRepo(dir, (repo) => {
        expect(refs.size).toBeGreaterThanOrEqual(7);
        for (const [name, oid] of refs) expect(repo.resolveRef(name), name).toBe(oid);
        expect(repo.head()).toEqual({ oid: refs.get('HEAD'), ref: 'refs/heads/main' });
        expect(repo.resolveRef('refs/heads/none')).toBeNull();
      });
      return refs;
    };
    const loose = expectRefs();
    const first = loose.get('refs/heads/side')!;
    const second = loose.get('refs/heads/main')!;
    expect(first).not.toBe(second);

    git(dir, ['pack-refs', '--all']);
    expect(readFileSync(path.join(dir, '.git', 'packed-refs'), 'utf8')).toMatch(/^\^[0-9a-f]{40}$/m); // a peeled tag line is present
    expect(expectRefs()).toEqual(loose);

    // a loose ref wins over its (now stale) packed-refs line
    writeFileSync(path.join(dir, '.git', 'refs', 'heads', 'main'), first + '\n');
    expect(expectRefs().get('refs/heads/main')).toBe(first);

    withRepo(dir, (repo) => {
      // the annotated tag resolves to the tag object, which names the commit
      const obj = repo.readObject(repo.resolveRef('refs/tags/v1')!)!;
      expect(obj.type).toBe('tag');
      const tag = parseTag(obj.data);
      expect(tag).toMatchObject({ object: first, type: 'commit', tag: 'v1', message: 'release one\n\nwith a body\n' });
      expect(tag.tagger).toEqual({ name: 'Tester', email: 'tester@example.com', time: 1706832000, tz: 330 });
      expect(repo.resolveRef('refs/tags/light')).toBe(first);
    });

    // HEAD as git writes it for a detached checkout, and for a branch that is itself symbolic
    writeFileSync(path.join(dir, '.git', 'HEAD'), second + '\n');
    withRepo(dir, (repo) => expect(repo.head()).toEqual({ oid: second, ref: null }));
    writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/alias\n');
    withRepo(dir, (repo) => expect(repo.head()).toEqual({ oid: first, ref: 'refs/heads/alias' }));
  });

  it('ref names that would leave .git, and symbolic refs that loop, resolve to null', () => {
    const oid = 'a'.repeat(40);
    const repo = openGitRepo(new MemoryGitFs({
      HEAD: enc('ref: refs/heads/a\n'),
      'refs/heads/a': enc('ref: refs/heads/b\n'),
      'refs/heads/b': enc('ref: refs/heads/a\n'),
      'refs/heads/ok': enc(oid + '\n'),
      'refs/heads/garbage': enc('not an object id\n'),
      'packed-refs': enc(`# pack-refs with: peeled fully-peeled sorted \n${'b'.repeat(40)} refs/tags/t\n^${'c'.repeat(40)}\n`),
    }));
    expect(repo.head()).toEqual({ oid: null, ref: 'refs/heads/a' });
    expect(repo.resolveRef('refs/heads/ok')).toBe(oid);
    expect(repo.resolveRef('refs/heads/garbage')).toBeNull();
    expect(repo.resolveRef('refs/tags/t')).toBe('b'.repeat(40));
    for (const name of ['', '/HEAD', '../HEAD', 'refs/../../outside', 'refs\\heads\\ok']) expect(repo.resolveRef(name), name).toBeNull();
  });

  it('a missing or empty HEAD is an empty answer, not an error', () => {
    expect(openGitRepo(new MemoryGitFs({})).head()).toEqual({ oid: null, ref: null });
    expect(openGitRepo(new MemoryGitFs({ HEAD: enc('\n') })).head()).toEqual({ oid: null, ref: null });
    expect(openGitRepo(new MemoryGitFs({ HEAD: enc('zzzz\n') })).head()).toEqual({ oid: null, ref: null });
  });
});

describe('config and remote URL', () => {
  /** Entries as `git config --file <text> --list -z` prints them: [name, value]. */
  function gitConfigList(name: string, text: string): string[][] {
    const dir = path.join(projectRoot(), '.fixtures', 'git-x-config');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, name), text);
    return git(dir, ['config', '--file', name, '--list', '-z']).split('\0').filter(Boolean).map((rec) => {
      const nl = rec.indexOf('\n');
      return nl < 0 ? [rec, 'true'] : [rec.slice(0, nl), rec.slice(nl + 1)]; // a key with no '=' is a true boolean
    });
  }
  const ours = (text: string): string[][] =>
    parseGitConfig(text).map((e) => [`${e.section}${e.subsection === null ? '' : '.' + e.subsection}.${e.key}`, e.value]);

  it('parseGitConfig reads a tricky file the way git config --list does', () => {
    const text = [
      '# a comment',
      '; another',
      '[core]',
      '\tbare = false',
      '\tIgnoreCase=TRUE   ',
      '  editor = "vim -u \\"none\\"" ; trailing comment',
      '\tpager = less # not part of the value',
      '\thash = "a # b ; c"',
      '\tspaces =   two  words   ',
      '\tquotedtail = "kept  "',
      '\tescapes = tab\\there\\nnewline\\\\slash',
      '\tcontinued = first \\',
      'second',
      '\tempty =',
      '\tflag',
      '[Remote "Origin"]',
      '\turl = https://user:secret@example.com/acme/widgets.git',
      '[remote "with \\"quote\\" and \\\\ slash"]',
      '\turl = /srv/git/w.git',
      '[branch.legacy]',
      '\tremote = origin',
      '[section] inline = yes',
      '[alias]',
      '\tco = checkout',
      '\tco = checkout -q',
      '',
    ].join('\r\n');
    const expected = gitConfigList('tricky', text);
    expect(ours(text)).toEqual(expected);
    expect(expected.length).toBeGreaterThan(15);
  });

  // Defect: repo.ts parseGitConfig strips leading blanks after unquoting (`.replace(/^[ \t]+/, '')` on the
  // finished value), so `k = "  x"` reads as "x"; git keeps blanks that were inside quotes.
  it.fails('parseGitConfig keeps leading blanks that were quoted, as git does', () => {
    const text = '[core]\n\tk = "  kept"\n';
    const expected = gitConfigList('quoted-lead', text);
    expect(expected).toEqual([['core.k', '  kept']]);
    expect(ours(text)).toEqual(expected);
  });

  it('remoteUrl prefers origin, falls back to the first remote, and strips credentials', () => {
    const repoWith = (config: string): GitRepository => openGitRepo(new MemoryGitFs({ config: enc(config) }));
    expect(repoWith('[remote "upstream"]\n\turl = git@example.com:up/stream.git\n[remote "origin"]\n\turl = https://u:p@example.com/me/fork.git\n').remoteUrl())
      .toBe('example.com/me/fork');
    expect(repoWith('[remote "upstream"]\n\turl = git@example.com:up/stream.git\n').remoteUrl()).toBe('example.com/up/stream');
    expect(repoWith('[core]\n\tbare = false\n').remoteUrl()).toBeNull();
    expect(openGitRepo(new MemoryGitFs({})).remoteUrl()).toBeNull();
  });

  it('normalizeRemoteUrl: one identity for the spellings of one remote; ports, paths and local folders', () => {
    const same = [
      'https://example.com/a/b', 'https://example.com/a/b.git', 'https://example.com/a/b/', 'https://example.com:443/a/b.git',
      'http://example.com:80/a/b', 'git://example.com:9418/a/b.git', 'ssh://git@example.com/a/b.git', 'ssh://git@example.com:2222/a/b',
      'git@example.com:a/b.git', 'example.com:a/b', 'HTTPS://tok:en@Example.COM/a/b.git', 'https://example.com/a/b.git?ref=x#frag',
    ];
    for (const url of same) expect(normalizeRemoteUrl(url), url).toBe('example.com/a/b');
    expect(normalizeRemoteUrl('https://example.com:8443/a/b.git')).toBe('example.com:8443/a/b'); // a non-default port is part of the identity
    expect(normalizeRemoteUrl('https://example.com/A/B')).toBe('example.com/A/B');               // paths keep their case
    expect(normalizeRemoteUrl('C:\\work\\repo.git')).toBe('C:/work/repo');
    expect(normalizeRemoteUrl('/srv/git/repo.git/')).toBe('/srv/git/repo');
    expect(normalizeRemoteUrl('../sibling')).toBe('../sibling');
    expect(normalizeRemoteUrl('file:///srv/git/repo.git')).toBe('/srv/git/repo');
    expect(normalizeRemoteUrl('   ')).toBeNull();
    // credentials never survive, whatever the scheme
    for (const url of ['https://user:hunter2@example.com/a/b', 'ssh://user:hunter2@example.com/a/b', 'http://hunter2@example.com/a/b']) {
      expect(normalizeRemoteUrl(url)).not.toContain('hunter2');
    }
  });
});

describe('commit and tree objects', () => {
  it('root, ordinary and merge commits parse to what git log reports, time zones included', () => {
    const dir = freshRepo('objects-merge');
    const commit = (branch: string, mark: number, message: string, when: [string, string], body: string): string =>
      `commit refs/heads/${branch}\nmark :${mark}\nauthor Zoë Ünïcode <zoe@example.com> ${when[0]}\ncommitter Tester <tester@example.com> ${when[1]}\n${data(message)}${body}`;
    gitIn(dir, ['fast-import', '--quiet'], [
      commit('main', 1, 'root\n', ['1706745600 +0000', '1706745600 +0000'], `M 100644 inline a.txt\n${data('a\n')}`),
      commit('side', 2, 'side work\n', ['1706745660 +0100', '1706745661 +0100'], `from :1\nM 100644 inline b.txt\n${data('b\n')}`),
      commit('main', 3, 'main work\n', ['1706745720 -0330', '1706745722 +0000'], `from :1\nM 100644 inline c.txt\n${data('c\n')}`),
      commit('main', 4, 'Merge side\n\nA body line.\n', ['1709323200 -0800', '1709325000 +0545'], 'from :3\nmerge :2\n'),
    ].join(''));
    const rows = git(dir, ['log', '--all', '--format=%H%x01%T%x01%P%x01%an%x01%ae%x01%at%x01%cn%x01%ce%x01%ct%x01%B%x00'])
      .split('\0').map((r) => r.replace(/^\n/, '')).filter(Boolean).map((r) => r.split('\x01'));
    expect(rows.length).toBe(4);
    withRepo(dir, (repo) => {
      const parentCounts: number[] = [];
      for (const [oid, tree, parents, an, ae, at, cn, ce, ct, message] of rows) {
        const obj = repo.readObject(oid)!;
        expect(obj.type).toBe('commit');
        const c = parseCommit(obj.data);
        expect(c.tree).toBe(tree);
        expect(c.parents).toEqual(parents.split(' ').filter(Boolean));
        expect(c.author).toMatchObject({ name: an, email: ae, time: Number(at) });
        expect(c.committer).toMatchObject({ name: cn, email: ce, time: Number(ct) });
        expect(c.message.trimEnd()).toBe(message.trimEnd());
        parentCounts.push(c.parents.length);
      }
      expect(parentCounts.sort()).toEqual([0, 1, 1, 2]);
      const merge = parseCommit(repo.readObject(repo.head().oid!)!.data);
      expect(merge.parents.length).toBe(2);
      expect(merge.message).toBe('Merge side\n\nA body line.\n');
      expect([merge.author.tz, merge.committer.tz]).toEqual([-480, 345]);
      expect(parseCommit(repo.readObject(merge.parents[0])!.data).author.tz).toBe(-210);
    });
  });

  it('multi-line headers (gpgsig), odd names and a missing tree', () => {
    const tree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
    const parent = '1'.repeat(40);
    const text = [
      `tree ${tree}`,
      `parent ${parent}`,
      'author Zoë Ünïcode <zoe@example.com> 1700000000 +0100',
      'committer  <> 1700000001 +0000',
      'gpgsig -----BEGIN PGP SIGNATURE-----',
      ' ',
      ' parent 2222222222222222222222222222222222222222',
      ' tree 3333333333333333333333333333333333333333',
      ' -----END PGP SIGNATURE-----',
      'encoding UTF-8',
      '',
      'Subject line',
      '',
      'tree is mentioned in the body',
      'parent too',
      '',
    ].join('\n');
    const c = parseCommit(enc(text));
    expect(c.tree).toBe(tree);
    expect(c.parents).toEqual([parent]); // the indented lines of the signature are not headers
    expect(c.author).toEqual({ name: 'Zoë Ünïcode', email: 'zoe@example.com', time: 1700000000, tz: 60 });
    expect(c.committer).toEqual({ name: '', email: '', time: 1700000001, tz: 0 });
    expect(c.message).toBe('Subject line\n\ntree is mentioned in the body\nparent too\n');
    expect(() => parseCommit(enc('author A <a@example.com> 1 +0000\n\nno tree\n'))).toThrow(/tree/);
    // a commit with no message at all still parses
    expect(parseCommit(enc(`tree ${tree}\nauthor A <a@example.com> 5 +0000\ncommitter A <a@example.com> 5 +0000\n`)).message).toBe('');
  });

  it('trees with every entry kind (file, executable, symlink, submodule, folder) equal git ls-tree', () => {
    const dir = freshRepo('objects-tree');
    const staged: [string, string][] = [
      ['100644', 'plain.txt'], ['100644', 'dir/inner.txt'], ['100644', 'dir/deeper/leaf.txt'], ['100644', 'dir.txt'], // 'dir.txt' sorts before 'dir/'
      ['100644', 'ünï/日本.txt'], ['100755', 'run.sh'], ['120000', 'link'], ['160000', 'vendor/sub'],
    ];
    gitIn(dir, ['update-index', '--index-info'], staged.map(([mode, p]) => `${mode} ${mode === '160000' ? '5'.repeat(40) : EMPTY_BLOB} 0\t${p}\n`).join(''));
    const root = git(dir, ['write-tree', '--missing-ok']).trim();
    // one listing of every tree and blob with its full path; group it by folder to get each tree's own entries
    const byDir = new Map<string, { mode: number; name: string; oid: string }[]>();
    const treeOid = new Map<string, string>([['', root]]);
    for (const line of git(dir, ['-c', 'core.quotepath=off', 'ls-tree', '-r', '-t', root]).split('\n').filter(Boolean)) {
      const [meta, full] = line.split('\t');
      const [mode, type, oid] = meta.split(' ');
      const cut = full.lastIndexOf('/');
      const parent = cut < 0 ? '' : full.slice(0, cut);
      if (!byDir.has(parent)) byDir.set(parent, []);
      byDir.get(parent)!.push({ mode: parseInt(mode, 8), name: full.slice(cut + 1), oid });
      if (type === 'tree') treeOid.set(full, oid);
    }
    expect([...treeOid.keys()].sort()).toEqual(['', 'dir', 'dir/deeper', 'vendor', 'ünï']);
    withRepo(dir, (repo) => {
      const modes = new Set<number>();
      for (const [folder, oid] of treeOid) {
        const obj = repo.readObject(oid)!;
        expect(obj.type).toBe('tree');
        const entries = parseTree(obj.data);
        expect(entries, folder).toEqual(byDir.get(folder));
        for (const e of entries) modes.add(e.mode);
      }
      expect([...modes].sort()).toEqual([MODE_TREE, MODE_FILE, MODE_EXEC, MODE_SYMLINK, MODE_GITLINK].sort());
      // the index reports the same modes for the same paths
      const byPath = new Map(repo.indexEntries().map((e) => [e.path, e.mode]));
      expect([byPath.get('run.sh'), byPath.get('link'), byPath.get('vendor/sub')]).toEqual([MODE_EXEC, MODE_SYMLINK, MODE_GITLINK]);
    });
    expect(() => parseTree(enc('100644 name\0tooshort'))).toThrow(/truncated/);
    expect(parseTree(new Uint8Array(0))).toEqual([]);
  });

  it('every tracked file of the fixture reads back from the object store as the committed bytes', () => {
    const dir = buildFixtureRepo('three-lang');
    withRepo(dir, (repo) => {
      let packed = 0, loose = 0;
      for (const e of repo.indexEntries()) {
        const obj = repo.readObject(e.oid)!;
        expect(obj.type, e.path).toBe('blob');
        // the fixture's working tree is exactly its last commit, written without line-ending conversion
        expect(Buffer.from(obj.data).equals(readFileSync(path.join(dir, e.path))), e.path).toBe(true);
        expect(obj.data.length).toBe(e.size);
        if (repo.isPacked(e.oid)) packed++; else loose++;
      }
      expect(packed).toBeGreaterThan(0);
      expect(loose).toBeGreaterThan(0);
    });
  });
});
