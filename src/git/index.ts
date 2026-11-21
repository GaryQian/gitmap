// Public surface of src/git (browser-safe). Package 1C owns this folder. Node-only code lives in ./node.ts.
import type { GitFs, GitRepo, IndexEntry, RepoAccess, RepoLocator } from '../contracts/git';

/** Parse .git/index (v2–v4) into tracked entries. Throws on anything unsupported. */
export function parseGitIndex(_buf: Uint8Array): IndexEntry[] {
  throw new Error('not implemented: parseGitIndex (package 1C)');
}

export interface GitRepoOptions {
  /** Page size for pack reads. Default config.history.pageBytes. */
  pageBytes?: number;
  /** Object cache budget in bytes. Default config.history.cacheBytes. */
  cacheBytes?: number;
}

/** A parsed view over a .git directory. */
export function openGitRepo(_fs: GitFs, _opts?: GitRepoOptions): GitRepo {
  throw new Error('not implemented: openGitRepo (package 1C)');
}

/**
 * Open the repo a locator points at, from a browser worker ('fsa', 'files') or anywhere ('memory').
 * For 'node' locators use openNodeRepoAccess from ./node. `git` is null when there is no .git directory.
 */
export async function openRepoAccess(_locator: RepoLocator): Promise<RepoAccess> {
  throw new Error('not implemented: openRepoAccess (package 1C)');
}
