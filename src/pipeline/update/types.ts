// Shapes of the update flow (PLAN.md §6.3.1 "Background working-tree check", §6.8, §12).
import type { GitFs, GitRepo } from '../../contracts/git';
import type { BuildManifest, Manifest, RunFastPass, RunSlowPass } from '../../contracts/ingest';

/**
 * A file as the map knows it: its path and the blob oid its facts were parsed from ('' when unknown).
 * `ManifestEntry`, `FileFacts` and a row of the model's file table all fit.
 */
export interface KnownFile {
  path: string;
  oid: string;
  /** Size in bytes. Only used to compare files that are never opened (binary, over the size cap). */
  bytes?: number;
}

/** Paths of a fresh manifest against what the map knows, by blob oid. Every list is sorted. */
export interface ManifestDiff {
  /** In the manifest, not on the map. */
  added: string[];
  /** On both sides with a different oid, or with an empty oid on either side (it cannot be compared). */
  changed: string[];
  /** On the map, no longer in the manifest. */
  removed: string[];
  /** On both sides with the same, non-empty oid. */
  unchanged: string[];
}

export interface WorkingTreeCheckOptions {
  /** Aborting resolves with what has been found so far; test `signal.aborted` before trusting the list. */
  signal?: AbortSignal;
  /** Files examined at once. */
  concurrency?: number;
  onProgress?(done: number, total: number): void;
  /** Modified times this close together count as equal. */
  mtimeToleranceMs?: number;
  /** Inject a GitRepo in tests. Defaults to openGitRepo from src/git. */
  openGit?(fs: GitFs): GitRepo;
}

/** A tracked file whose content on disk is not what the map shows (confirmWorkingTree). */
export interface WorkingTreeChange {
  path: string;
  /** Git blob hash of the bytes on disk; '' when it was not hashed (missing, binary, over the size cap). */
  oid: string;
  /** Size on disk. */
  bytes?: number;
  /** The file is tracked but no longer on disk. */
  missing?: boolean;
}

/**
 * What the working-tree check found, as planUpdate and applyUpdate take it: confirmed changes, or
 * bare paths straight from checkWorkingTree (each is then re-read from disk without knowing its hash).
 */
export type WorkingTreeInput = readonly (string | WorkingTreeChange)[];

/** What an update would do, and the number behind "N files changed · Update". */
export interface UpdatePlan {
  /** The fresh manifest the plan was made against. */
  manifest: Manifest;
  /** The comparison by blob oid alone, before the working tree is taken into account. */
  diff: ManifestDiff;
  /** Paths whose facts on the map are out of date: added, changed, or edited on disk. Sorted. */
  reparse: string[];
  /** Paths to take off the map: gone from the manifest, or tracked but deleted on disk. Sorted. */
  drop: string[];
  /** Paths read from the working tree instead of from git, with what is known of their content. */
  fromDisk: Record<string, WorkingTreeChange>;
  /** Tracked paths that are not on disk: left out of the map even when the manifest lists them. Sorted. */
  missing: string[];
  /** `reparse.length + drop.length`. */
  count: number;
}

/** The ingest functions the update runs, injectable so tests can supply fakes. */
export interface UpdateLib {
  buildManifest: BuildManifest;
  runFastPass: RunFastPass;
  runSlowPass: RunSlowPass;
}

export interface ApplyUpdateOptions extends Partial<UpdateLib> {
  /** A manifest built a moment ago, to save building it again. It must describe the folder as it is now. */
  manifest?: Manifest;
  /**
   * Open the folder again before reading it (default true when the source has a locator). A browser
   * repo handle is a snapshot: it does not see an index, packs or loose objects written since.
   */
  reopen?: boolean;
  /**
   * When no working-tree result is passed, run checkWorkingTree and confirmWorkingTree here, so the
   * update is based on the folder as it is at the click. Costs one metadata lookup per tracked file.
   */
  checkWorkingTree?: boolean;
  /** Aborting rejects, and the state is left as it was. */
  signal?: AbortSignal;
  onProgress?(pass: 'fastPass' | 'slowPass', done: number, total: number): void;
}

export interface UpdateResult {
  plan: UpdatePlan;
  /** Paths whose facts were produced by this update (re-read, or served by the facts cache). Manifest order. */
  parsed: string[];
  /** Number of files whose facts were carried over untouched. */
  kept: number;
  /** Paths taken off the map. Sorted. */
  dropped: string[];
  /** For `analyzeAndApply(..., { extraMeta })`: the head and index the map now describes. */
  meta: { headOid: string | null; indexChecksum: string | null };
  /** Set when the slow pass failed outright; the fast-pass facts were still merged. */
  slowPassError?: string;
}
