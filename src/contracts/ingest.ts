// Manifest and parse passes (PLAN.md §6.2, §6.3). Implemented by src/ingest.
import type { Config } from '../config';
import type { LangId } from '../model/types';
import type { ComputePool, Lane } from './compute';
import type { RepoAccess } from './git';
import type { FileFacts, SyntaxFacts } from './lang';

export interface ManifestEntry {
  path: string;
  /** Blob oid from the index; '' for a plain folder or an untracked file. */
  oid: string;
  bytes: number;
  lang: LangId | null;
  /**
   * How the parse reads it: 'pack' = from the git packfile, 'tree' = from the working tree,
   * 'none' = never opened (binary by extension, over the size cap); it still gets a sphere.
   */
  read: 'pack' | 'tree' | 'none';
  /** Pack offset for ordering reads; −1 when not packed. */
  packOffset: number;
}

export interface Manifest {
  repoName: string;
  source: 'git' | 'folder';
  headOid: string | null;
  indexChecksum: string | null;
  remoteUrl: string | null;
  /** Files on the map, sorted by path. */
  entries: ManifestEntry[];
  /** Tracked paths dropped by config.parser.exclude, submodules and symlinks. */
  excluded: number;
  totalBytes: number;
  /** Set when history overlays will be unavailable, with the reason. */
  historyUnavailable?: string;
}

/** Parse facts cached by blob oid, so a return visit reads only changed blobs (PLAN.md §6.3). */
export interface FactsCache {
  getFacts(oids: string[]): Promise<Map<string, FileFacts>>;
  putFacts(facts: FileFacts[]): Promise<void>;
  getSyntax(oids: string[]): Promise<Map<string, SyntaxFacts>>;
  putSyntax(facts: SyntaxFacts[]): Promise<void>;
}

export interface PassOptions<T = unknown> {
  lane?: Lane;
  cache?: FactsCache;
  /**
   * `share` is the part of the work that is done, 0–1, weighted by file size: a count of files runs
   * ahead of the work, because the many small files finish first.
   */
  onProgress?(done: number, total: number, share?: number): void;
  /**
   * Called with each batch of results as it finishes (in completion order), so a caller can use
   * what has arrived so far without waiting for the pass to end (the reveal escape hatch, PLAN.md §6.8).
   */
  onBatch?(results: T[]): void;
  signal?: AbortSignal;
}

/** src/ingest exports these. */
export type BuildManifest = (repo: RepoAccess, config: Config) => Promise<Manifest>;
/** Fast pass over every entry: one FileFacts per manifest entry, in manifest order. */
export type RunFastPass = (manifest: Manifest, pool: ComputePool, config: Config, opts?: PassOptions<FileFacts>) => Promise<FileFacts[]>;
/** Slow pass over entries whose language has one. Resolves with whatever finished if the signal aborts. */
export type RunSlowPass = (manifest: Manifest, pool: ComputePool, config: Config, opts?: PassOptions<SyntaxFacts>) => Promise<SyntaxFacts[]>;
