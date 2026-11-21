// Repo access. The browser paths run here against stand-ins for the File System Access API and
// FileReaderSync that serve the fixture repo from disk; the real APIs are exercised by the e2e smoke test.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RepoAccess } from '../contracts/git';
import { buildFixtureRepo, git, projectRoot } from '../testing/fixture';
import { BrowserGitFs, hashObject, openGitRepo, openRepoAccess } from './index';
import { NodeGitFs, openNodeRepoAccess } from './node';

const dir = buildFixtureRepo('three-lang');
const headOid = git(dir, ['rev-parse', 'HEAD']).trim();
const packedBlob = git(dir, ['rev-parse', 'HEAD:README.md']).trim();
const looseBlob = git(dir, ['rev-parse', 'HEAD:docs/notes.txt']).trim();
const tracked = git(dir, ['ls-files']).split('\n').filter(Boolean);

function walk(abs: string, base = ''): string[] {
  return readdirSync(abs, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(path.join(abs, d.name), `${base}${d.name}/`) : [base + d.name]);
}

// --- stand-ins for browser objects -------------------------------------------------------------
interface FakeBlob { size: number; lastModified: number; bytes: Uint8Array; slice(a: number, b: number): FakeBlob; arrayBuffer(): Promise<ArrayBuffer> }
function fakeBlob(bytes: Uint8Array, lastModified = 0): FakeBlob {
  return {
    size: bytes.length, lastModified, bytes,
    slice: (a, b) => fakeBlob(bytes.subarray(a, b)),
    arrayBuffer: async () => new Uint8Array(bytes).buffer,
  };
}
const fakeFile = (abs: string): File => fakeBlob(new Uint8Array(readFileSync(abs)), statSync(abs).mtimeMs) as unknown as File;
class FakeFileReaderSync {
  readAsArrayBuffer(blob: FakeBlob): ArrayBuffer { return new Uint8Array(blob.bytes).buffer; }
}
function domError(name: string): Error {
  return Object.assign(new Error(name), { name });
}
function fakeDirHandle(abs: string): FileSystemDirectoryHandle {
  const child = (name: string, want: 'file' | 'directory'): unknown => {
    const p = path.join(abs, name);
    const st = statSync(p, { throwIfNoEntry: false });
    if (!st) throw domError('NotFoundError');
    if (st.isDirectory() !== (want === 'directory')) throw domError('TypeMismatchError');
    return want === 'directory' ? fakeDirHandle(p) : { kind: 'file', name, getFile: async () => fakeFile(p) };
  };
  return {
    kind: 'directory', name: path.basename(abs),
    getDirectoryHandle: async (name: string) => child(name, 'directory'),
    getFileHandle: async (name: string) => child(name, 'file'),
    async *entries() {
      for (const d of readdirSync(abs, { withFileTypes: true })) yield [d.name, child(d.name, d.isDirectory() ? 'directory' : 'file')];
    },
  } as unknown as FileSystemDirectoryHandle;
}

/** The checks every kind of access must pass against the fixture. */
async function expectFixture(access: RepoAccess, opts: { objects: boolean }): Promise<void> {
  expect((await access.tree.list('')).map((e) => e.name)).toEqual([...new Set(tracked.map((p) => p.split('/')[0]))].sort());
  expect(await access.tree.list('web/src/util')).toEqual([{ name: 'format.ts', kind: 'file' }, { name: 'index.ts', kind: 'file' }]);
  const onDisk = readFileSync(path.join(dir, 'README.md'));
  expect(Buffer.from((await access.tree.read('README.md'))!).equals(onDisk)).toBe(true);
  expect((await access.tree.stat('README.md'))!.size).toBe(onDisk.length);
  expect(await access.tree.read('no/such/file.ts')).toBeNull();
  expect(await access.tree.list('no/such')).toEqual([]);

  expect(access.git).not.toBeNull();
  const repo = openGitRepo(access.git!);
  expect(repo.head()).toEqual({ oid: headOid, ref: 'refs/heads/main' });
  expect(repo.indexEntries().map((e) => e.path)).toEqual(tracked);
  if (!opts.objects) return;
  for (const oid of [packedBlob, looseBlob, headOid]) {
    const obj = repo.readObject(oid)!;
    expect(hashObject(obj.type, obj.data)).toBe(oid);
  }
  expect(repo.isPacked(packedBlob)).toBe(true);
  expect(repo.isPacked(looseBlob)).toBe(false);
}

afterEach(() => vi.unstubAllGlobals());

describe('repo access', () => {
  it('node: working tree and git directory; a plain folder has no git', async () => {
    const access = await openNodeRepoAccess(dir);
    expect(access.name).toBe('three-lang');
    await expectFixture(access, { objects: true });
    (access.git as NodeGitFs).close();
    const plain = await openNodeRepoAccess(path.join(projectRoot(), 'fixtures', 'three-lang', 'repo'));
    expect(plain.git).toBeNull();
    expect(await plain.tree.read('README.md')).not.toBeNull();
  });

  it('memory: keys under .git/ back the git directory, the rest is the working tree', async () => {
    const files: Record<string, Uint8Array> = {};
    for (const p of walk(dir)) if (!/^\.git\/(hooks|logs)\//.test(p)) files[p] = new Uint8Array(readFileSync(path.join(dir, p)));
    await expectFixture(await openRepoAccess({ kind: 'memory', name: 'mem', files }), { objects: true });
    const plain = await openRepoAccess({ kind: 'memory', name: 'plain', files: { 'a/b.ts': new Uint8Array([1]) } });
    expect(plain.git).toBeNull();
    expect(await plain.tree.list('')).toEqual([{ name: 'a', kind: 'dir' }]);
    // detached HEAD, and a branch that exists only in packed-refs
    const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
    const detached = await openRepoAccess({ kind: 'memory', name: 'd', files: { '.git/HEAD': enc(headOid + '\n') } });
    expect(openGitRepo(detached.git!).head()).toEqual({ oid: headOid, ref: null });
    const packed = await openRepoAccess({ kind: 'memory', name: 'p', files: {
      '.git/HEAD': enc('ref: refs/heads/topic\n'),
      '.git/packed-refs': enc(`# pack-refs with: peeled fully-peeled sorted \n${packedBlob} refs/heads/other\n${headOid} refs/heads/topic\n`),
      '.git/config': enc('[core]\n\tbare = false\n[remote "origin"]\n\turl = https://user:token@github.com/acme/widgets.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n'),
    } });
    const repo = openGitRepo(packed.git!);
    expect(repo.head()).toEqual({ oid: headOid, ref: 'refs/heads/topic' });
    expect(repo.remoteUrl()).toBe('github.com/acme/widgets');
    expect(repo.indexEntries()).toEqual([]);
  });

  it('fsa and files, in a worker (FileReaderSync): everything reads; loose objects can be deferred', async () => {
    vi.stubGlobal('FileReaderSync', FakeFileReaderSync);
    await expectFixture(await openRepoAccess({ kind: 'fsa', root: fakeDirHandle(dir) }), { objects: true });
    const files = walk(dir).map((p) => ({ path: p, file: fakeFile(path.join(dir, p)) }));
    await expectFixture(await openRepoAccess({ kind: 'files', name: 'dropped', files }), { objects: true });

    const lazy = await openRepoAccess({ kind: 'fsa', root: fakeDirHandle(dir) }, { looseLimit: 0 });
    const fs = lazy.git as BrowserGitFs;
    expect(fs.unresolvedLoose).toBeGreaterThan(0);
    expect(openGitRepo(fs).readObject(looseBlob)).toBeNull();
    await fs.resolveLoose();
    expect(openGitRepo(fs).readObject(looseBlob)).not.toBeNull();
  });

  it('fsa on the main thread (no FileReaderSync): head and index work, object reads say why they cannot', async () => {
    const access = await openRepoAccess({ kind: 'fsa', root: fakeDirHandle(dir) });
    await expectFixture(access, { objects: false });
    expect(() => openGitRepo(access.git!).readObject(packedBlob)).toThrow(/FileReaderSync/);
  });

  it('a .git file (worktree or submodule) means no git access in the browser', async () => {
    const wt = path.join(projectRoot(), '.fixtures', 'git-dotfile');
    mkdirSync(wt, { recursive: true });
    writeFileSync(path.join(wt, '.git'), 'gitdir: ../three-lang/.git\n');
    writeFileSync(path.join(wt, 'a.ts'), 'export {};\n');
    const fsa = await openRepoAccess({ kind: 'fsa', root: fakeDirHandle(wt) });
    expect(fsa.git).toBeNull();
    expect(await fsa.tree.list('')).toEqual([{ name: 'a.ts', kind: 'file' }]);
    const dropped = await openRepoAccess({ kind: 'files', name: 'wt', files: walk(wt).map((p) => ({ path: p, file: fakeFile(path.join(wt, p)) })) });
    expect(dropped.git).toBeNull();
  });
});
