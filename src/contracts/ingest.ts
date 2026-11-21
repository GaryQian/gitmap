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

export interface PassOptions {
  lane?: Lane;
  cache?: FactsCache;
  onProgress?(done: number, total: number): void;
  signal?: AbortSignal;
}

/** src/ingest exports these. */
export type BuildManifest = (repo: RepoAccess, config: Config) => Promise<Manifest>;
/** Fast pass over every entry: one FileFacts per manifest entry, in manifest order. */
export type RunFastPass = (manifest: Manifest, pool: ComputePool, config: Config, opts?: PassOptions) => Promise<FileFacts[]>;
/** Slow pass over entries whose language has one. Resolves with whatever finished if the signal aborts. */
export type RunSlowPass = (manifest: Manifest, pool: ComputePool, config: Config, opts?: PassOptions) => Promise<SyntaxFacts[]>;
