// The readers must agree with git itself: every check here compares against the git binary.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildFixtureRepo, git, projectRoot } from '../testing/fixture';
import {
  hashObject, normalizeRemoteUrl, openGitRepo, parseCommit, parseGitIndex, parseTree, sha1, toHex,
  UnsupportedIndexError, type GitRepository,
} from './index';
import { NodeGitFs } from './node';

/** `git ls-files -s` as [mode, oid, path] rows. */
function lsFiles(repo: string): [string, string, string][] {
  return git(repo, ['-c', 'core.quotepath=off', 'ls-files', '-s']).split('\n').filter(Boolean).map((line) => {
    const [meta, file] = line.split('\t');
    const [mode, oid] = meta.split(' ');
    return [mode, oid, file];
  });
}
const indexRows = (repo: string): [string, string, string][] =>
  parseGitIndex(readFileSync(path.join(repo, '.git', 'index'))).map((e) => [e.mode.toString(8), e.oid, e.path]);

/** Every object git knows in the repo must read back with the right type, size and SHA-1. */
function expectAllObjectsReadable(dir: string, repo: GitRepository): number {
  const rows = git(dir, ['cat-file', '--batch-all-objects', '--batch-check']).split('\n').filter(Boolean);
  for (const row of rows) {
    const [oid, type, size] = row.split(' ');
    const obj = repo.readObject(oid);
    expect(obj, `object ${oid}`).not.toBeNull();
    expect(obj!.type).toBe(type);
    expect(obj!.data.length).toBe(Number(size));
    expect(hashObject(obj!.type, obj!.data)).toBe(oid);
  }
  return rows.length;
}

async function withRepo<T>(dir: string, fn: (repo: GitRepository) => T): Promise<T> {
  const fs = new NodeGitFs(path.join(dir, '.git'));
  try { return fn(openGitRepo(fs)); } finally { fs.close(); }
}

describe('index', () => {
  it('v2 entries equal git ls-files -s, with size and mtime from the stat data', () => {
    const dir = buildFixtureRepo('three-lang');
    const buf = readFileSync(path.join(dir, '.git', 'index'));
    expect(indexRows(dir)).toEqual(lsFiles(dir));
    const readme = parseGitIndex(buf).find((e) => e.path === 'README.md')!;
    const st = statSync(path.join(dir, 'README.md'));
    expect(readme.size).toBe(st.size);
    expect(Math.floor(readme.mtimeMs / 1000)).toBe(Math.floor(st.mtimeMs / 1000));
  });

  it('v4 (prefix-compressed paths, including non-ASCII ones) equals git ls-files -s', () => {
    const dir = buildFixtureRepo('three-lang', 'v4');
    mkdirSync(path.join(dir, 'docs', 'ünï'), { recursive: true });
    for (const name of ['ä.txt', 'äö.txt', '日本.txt']) writeFileSync(path.join(dir, 'docs', 'ünï', name), name);
    git(dir, ['add', '-A']);
    git(dir, ['update-index', '--index-version', '4']);
    const buf = readFileSync(path.join(dir, '.git', 'index'));
    expect(new DataView(buf.buffer, buf.byteOffset).getUint32(4)).toBe(4);
    const rows = indexRows(dir);
    expect(rows).toEqual(lsFiles(dir));
    expect(rows.some((r) => r[2] === 'docs/ünï/日本.txt')).toBe(true);
  });

  it('a split index and a sparse index are refused with UnsupportedIndexError', () => {
    const split = buildFixtureRepo('three-lang', 'split');
    git(split, ['update-index', '--split-index']);
    writeFileSync(path.join(split, 'README.md'), 'changed\n');
    git(split, ['add', 'README.md']);
    const sparse = buildFixtureRepo('three-lang', 'sparse');
    git(sparse, ['sparse-checkout', 'set', '--cone', '--sparse-index', 'web']);
    for (const [dir, reason] of [[split, 'split-index'], [sparse, 'sparse-index']] as const) {
      let err: unknown;
      try { parseGitIndex(readFileSync(path.join(dir, '.git', 'index'))); } catch (e) { err = e; }
      expect(err, reason).toBeInstanceOf(UnsupportedIndexError);
      expect((err as UnsupportedIndexError).reason).toBe(reason);
    }
  });
});

describe('repo', () => {
  it('head, index checksum and remote URL', async () => {
    const dir = buildFixtureRepo('three-lang');
    await withRepo(dir, (repo) => {
      expect(repo.head()).toEqual({ oid: git(dir, ['rev-parse', 'HEAD']).trim(), ref: 'refs/heads/main' });
      const index = readFileSync(path.join(dir, '.git', 'index'));
      expect(repo.indexChecksum()).toBe(toHex(index, index.length - 20));
      expect(toHex(sha1(index.subarray(0, index.length - 20)))).toBe(repo.indexChecksum()); // what git wrote
      expect(repo.indexEntries().length).toBe(lsFiles(dir).length);
      expect(repo.isShallow()).toBe(false);
      expect(repo.remoteUrl()).toBeNull();
    });
    for (const url of ['git@github.com:a/b.git', 'https://github.com/a/b.git', 'https://user:secret@github.com/a/b', 'ssh://git@GitHub.com:22/a/b.git/']) {
      expect(normalizeRemoteUrl(url)).toBe('github.com/a/b');
    }
  });

  it('a packed blob and a loose blob equal git cat-file, and every object hashes to its id', async () => {
    const dir = buildFixtureRepo('three-lang');
    await withRepo(dir, (repo) => {
      const packed = git(dir, ['rev-parse', 'HEAD:README.md']).trim();   // first commit: packed by gc
      const loose = git(dir, ['rev-parse', 'HEAD:docs/notes.txt']).trim(); // last commit: still loose
      expect(repo.isPacked(packed)).toBe(true);
      expect(repo.packOffset(packed)).toBeGreaterThan(0);
      expect(repo.isPacked(loose)).toBe(false);
      expect(repo.packOffset(loose)).toBe(-1);
      for (const oid of [packed, loose]) {
        const obj = repo.readObject(oid)!;
        expect(obj.type).toBe('blob');
        expect(new TextDecoder().decode(obj.data)).toBe(git(dir, ['cat-file', '-p', oid]));
      }
      expect(repo.readObject('0'.repeat(40))).toBeNull();
      expect(expectAllObjectsReadable(dir, repo)).toBeGreaterThan(20);
    });
  });

  it('commits and trees parse to what git reports', async () => {
    const dir = buildFixtureRepo('three-lang');
    await withRepo(dir, (repo) => {
      const head = repo.head().oid!;
      const commit = parseCommit(repo.readObject(head)!.data);
      const [tree, parents, an, ae, at, cn, ce, ct] = git(dir, ['log', '-1', '--format=%T%n%P%n%an%n%ae%n%at%n%cn%n%ce%n%ct', head]).split('\n');
      expect(commit.tree).toBe(tree);
      expect(commit.parents).toEqual(parents.split(' ').filter(Boolean));
      expect(commit.author).toMatchObject({ name: an, email: ae, time: Number(at) });
      expect(commit.committer).toMatchObject({ name: cn, email: ce, time: Number(ct) });
      expect(commit.message.trim()).toBe(git(dir, ['log', '-1', '--format=%B', head]).trim());
      const entries = parseTree(repo.readObject(commit.tree)!.data);
      const expected = git(dir, ['ls-tree', head]).split('\n').filter(Boolean).map((line) => {
        const [meta, name] = line.split('\t');
        const [mode, , oid] = meta.split(' ');
        return { mode: parseInt(mode, 8), name, oid };
      });
      expect(entries).toEqual(expected);
    });
  });

  it('delta chains resolve: OFS deltas, REF deltas and a second pack', async () => {
    const dir = path.join(projectRoot(), '.fixtures', 'git-delta');
    const big = (edit: number): string => {
      // ~40 KB of text that does not compress to nothing. Commit n rewrites 30 lines and keeps the edits
      // of the commits before it, so each version is closest to its neighbour and the deltas chain.
      let seed = 7;
      const lines: string[] = [];
      for (let i = 0; i < 1500; i++) {
        seed = (seed * 1103515245 + 12345) >>> 0;
        const by = i % 50;
        lines.push(by >= 1 && by <= edit ? `edited in commit ${by}: ${(seed ^ 0x5bd1e995).toString(36)}` : `line ${i} ${seed.toString(36)}`);
      }
      return lines.join('\n') + '\n';
    };
    const commit = (n: number): void => {
      writeFileSync(path.join(dir, 'big.txt'), big(n));
      git(dir, ['add', 'big.txt']);
      const date = `2024-01-${10 + n}T00:00:00Z`;
      git(dir, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', `edit ${n}`], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
    };
    if (existsSync(path.join(dir, '.git', 'starmap-delta-ready'))) {
      // reuse the repo of an earlier run, without the extra commit that run added in step 3
      git(dir, ['reset', '-q', '--hard', 'base']);
      git(dir, ['reflog', 'expire', '--expire=now', '--all']);
    } else {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      git(dir, ['init', '-q', '-b', 'main']);
      for (let n = 0; n < 8; n++) commit(n);
      git(dir, ['tag', 'base']);
      writeFileSync(path.join(dir, '.git', 'starmap-delta-ready'), '');
    }
    const packDir = path.join(dir, '.git', 'objects', 'pack');
    /** Type code in the pack entry header of an object: 6 = OFS_DELTA, 7 = REF_DELTA. */
    const storedAs = (repo: GitRepository, oid: string): number => {
      const loc = repo.locate(oid)!;
      return (repo.fs.readAt(`objects/pack/${repo.odb.packs[loc.pack].name}.pack`, loc.offset, 1)[0] >> 4) & 7;
    };
    const blobs = git(dir, ['log', '--format=%H']).split('\n').filter(Boolean).map((c) => git(dir, ['rev-parse', `${c}:big.txt`]).trim());

    // 1. one pack, deltas by offset (git's default), with chains more than one delta deep
    git(dir, ['gc', '-q', '--aggressive', '--prune=now']);
    const idxFiles = readdirSync(packDir).filter((f) => f.endsWith('.idx')).map((f) => path.join(packDir, f));
    const depths = git(dir, ['verify-pack', '-v', ...idxFiles]).split('\n').map((l) => l.trim().split(/\s+/)).filter((c) => c.length === 7).map((c) => Number(c[5]));
    expect(Math.max(...depths)).toBeGreaterThan(1);
    await withRepo(dir, (repo) => {
      expect(blobs.map((b) => storedAs(repo, b))).toContain(6);
      expectAllObjectsReadable(dir, repo);
      expect(new TextDecoder().decode(repo.readObject(blobs[3])!.data)).toBe(git(dir, ['cat-file', '-p', blobs[3]]));
      expect(repo.odb.stats.maxChain).toBeGreaterThan(1);
    });

    // 2. the same objects with deltas that name their base by object id
    git(dir, ['-c', 'repack.useDeltaBaseOffset=false', 'repack', '-q', '-a', '-d', '-f', '--depth=20', '--window=20']);
    await withRepo(dir, (repo) => {
      expect(blobs.map((b) => storedAs(repo, b))).toContain(7);
      expectAllObjectsReadable(dir, repo);
    });

    // 3. a later commit packed on its own: two packs
    commit(15);
    git(dir, ['repack', '-q', '-d']);
    await withRepo(dir, (repo) => {
      expect(repo.odb.packs.length).toBeGreaterThan(1);
      expectAllObjectsReadable(dir, repo);
      expect(repo.head().oid).toBe(git(dir, ['rev-parse', 'HEAD']).trim());
    });
  });
});
