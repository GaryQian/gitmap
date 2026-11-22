// Disk access: the git directory, the working tree and file contents (PLAN.md §6.1–6.3, §12.1).
import type { NodeRef } from '../model/types';

/**
 * Synchronous random access to files under `.git`. Paths are relative to the .git directory and
 * '/'-separated. Browser: FileReaderSync over File.slice() in a worker. Node: fs.readSync.
 */
export interface GitFs {
  readAt(path: string, offset: number, length: number): Uint8Array;
  /** File size in bytes, −1 when missing. */
  size(path: string): number;
  /** Entry names of a directory, [] when missing. */
  list(dir: string): string[];
}

export interface DirEntry { name: string; kind: 'file' | 'dir' }

/** Asynchronous access to the user's folder. Paths are repo-relative, '/'-separated. */
export interface WorkingTree {
  /** File bytes, or null when the file does not exist or cannot be read. */
  read(path: string): Promise<Uint8Array | null>;
  stat(path: string): Promise<{ size: number; mtimeMs: number } | null>;
  /** Entries of a directory ('' is the root), [] when missing. */
  list(dir: string): Promise<DirEntry[]>;
}

/** Everything a worker needs to read a repo. `git` is null for a plain folder. */
export interface RepoAccess {
  name: string;
  tree: WorkingTree;
  git: GitFs | null;
}

/**
 * How a worker is told which repo to open. It is structured-cloneable, so the pool can broadcast it.
 * - fsa:    a File System Access directory handle (Chromium).
 * - files:  a flat list of dropped / <input webkitdirectory> files (Firefox, Safari).
 * - node:   an absolute path (scripts, tests).
 * - memory: path → bytes (tests); keys under '.git/' back the GitFs.
 */
export type RepoLocator =
  | { kind: 'fsa'; root: FileSystemDirectoryHandle }
  | { kind: 'files'; name: string; files: { path: string; file: File }[] }
  | { kind: 'node'; rootPath: string }
  | { kind: 'memory'; name: string; files: Record<string, Uint8Array> };

export interface IndexEntry {
  path: string;
  oid: string;      // 40 hex chars
  size: number;     // bytes on disk when staged
  mode: number;     // 0o100644, 0o100755, 0o120000 (symlink), 0o160000 (submodule)
  mtimeMs: number;  // stat time recorded in the index
}

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

/** A parsed view of one repository's .git directory. Implemented by src/git (openGitRepo). */
export interface GitRepo {
  readonly fs: GitFs;
  /** Resolved HEAD. `oid` is null in an empty repo. */
  head(): { oid: string | null; ref: string | null };
  /** Tracked files from .git/index (v2–v4). Throws on an unsupported index. */
  indexEntries(): IndexEntry[];
  /** Hex SHA-1 trailer of .git/index: changes whenever the index does. */
  indexChecksum(): string;
  /** Origin remote URL from .git/config with credentials removed, or null. */
  remoteUrl(): string | null;
  /** Read any object by hex oid, from packs or loose objects. Null when absent. Synchronous. */
  readObject(oid: string): { type: GitObjectType; data: Uint8Array } | null;
  /** True when the object is stored in a packfile (cheap to read, PLAN.md §6.3.1). */
  isPacked(oid: string): boolean;
  /** Pack offset of an object, for sorting reads; −1 when loose or absent. */
  packOffset(oid: string): number;
  /** True for a shallow clone. */
  isShallow(): boolean;
}

/** One way to read a file's bytes, whatever the source (PLAN.md §12.1). */
export interface ContentSource {
  /** Bytes of a file ('f:path'), or of a unit's primary file ('u:path'). Rejects when unavailable. */
  read(file: NodeRef): Promise<Uint8Array>;
  /**
   * Replace a file's bytes on disk. Present only when the source is a folder the browser can write
   * to; the sidebar editor offers a download instead when it is absent. Must be called from a user
   * gesture (the first write asks for write permission). Rejects with a message fit to show.
   */
  write?(file: NodeRef, bytes: Uint8Array): Promise<void>;
}
