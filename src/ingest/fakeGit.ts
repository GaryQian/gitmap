// Test helper: a GitRepo over a list of files, so the manifest and fast pass can be tested without
// src/git. Not used by the app.
import type { GitFs, GitRepo, IndexEntry } from '../contracts/git';
import { MemoryGitFs } from '../testing/memory';

export interface FakeGitFile {
  path: string;
  /** Staged content. */
  text: string;
  mode?: number;
  /** Stored in a packfile (default) or as a loose object. */
  packed?: boolean;
  /** Size recorded in the index when it should differ from the content length. */
  size?: number;
}

export interface FakeGit {
  fs: GitFs;
  repo: GitRepo;
  oidOf(path: string): string;
  /** Oids asked of readObject, in order. */
  reads: string[];
}

export function fakeGit(files: FakeGitFile[], opts: { indexThrows?: string } = {}): FakeGit {
  const fs = new MemoryGitFs({});
  const encoder = new TextEncoder();
  const oid = (i: number) => (i + 1).toString(16).padStart(40, '0');
  const byOid = new Map(files.map((f, i) => [oid(i), { file: f, offset: (files.length - i) * 100 }]));
  const reads: string[] = [];
  const repo: GitRepo = {
    fs,
    head: () => ({ oid: 'f'.repeat(40), ref: 'refs/heads/main' }),
    indexEntries(): IndexEntry[] {
      if (opts.indexThrows) throw new Error(opts.indexThrows);
      return files.map((f, i) => ({ path: f.path, oid: oid(i), size: f.size ?? encoder.encode(f.text).length, mode: f.mode ?? 0o100644, mtimeMs: 0 }));
    },
    indexChecksum: () => 'c'.repeat(40),
    remoteUrl: () => 'https://example.com/acme/repo.git',
    readObject(o) {
      reads.push(o);
      const hit = byOid.get(o);
      return hit ? { type: 'blob', data: encoder.encode(hit.file.text) } : null;
    },
    isPacked: (o) => byOid.get(o)?.file.packed !== false && byOid.has(o),
    packOffset(o) {
      const hit = byOid.get(o);
      return hit && hit.file.packed !== false ? hit.offset : -1;
    },
    isShallow: () => false,
  };
  return { fs, repo, reads, oidOf: (path) => oid(files.findIndex((f) => f.path === path)) };
}
