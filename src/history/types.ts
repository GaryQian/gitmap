// Public types of src/history: per-file facts from the git history walk (PLAN.md §6.5) and the
// messages exchanged between the driver and its two pool tasks.

/**
 * How merge commits are treated (config.history.merges):
 * - skip:        every commit reachable from HEAD is walked; a merge contributes nothing.
 * - include:     every commit is walked; a merge is diffed against its first parent, so what its
 *                branch brought in is counted on the branch commits and again on the merge.
 * - firstParent: only the mainline (first parents) is walked; a merge is diffed against its first parent.
 */
export type MergeMode = 'skip' | 'firstParent' | 'include';

export interface FileHistory {
  /** Commits that touched the path. */
  commits: number;
  /** Author time of the newest touching commit, in seconds since the Unix epoch. */
  lastModified: number;
  /** Author time of the oldest touching commit seen so far, in seconds. */
  firstSeen: number;
  /** [contributor index, commits], most commits first. */
  authors: [contributor: number, commits: number][];
  /** Contributor index of the author of the commit that set `lastModified`. */
  lastAuthor: number;
  /**
   * First 32 bits of that commit's id. When two commits share the newest author time, the larger
   * prefix wins, so `lastAuthor` does not depend on the order in which results were merged.
   */
  lastOidPrefix: number;
}

export interface Contributor {
  /** The contributor's index in HistoryResult.contributors: what FileHistory.authors and lastAuthor refer to. */
  id: number;
  /** Canonical name: from .mailmap when it gives one, else the name on the contributor's newest commit. */
  name: string;
  /** Canonical email first, then every other address seen for this contributor. */
  emails: string[];
  /** Commits authored within the walked window (merges only when merges are counted). */
  commits: number;
  /** Author time of the contributor's newest commit, in seconds. */
  lastActive: number;
}

/** Why a walk ended before the root commit(s). */
export type HistoryStop =
  | 'maxCommits' | 'timeBudget'
  /** A shallow clone: the history below the boundary is not on disk. */
  | 'shallow'
  /** A parent commit or a tree is absent (partial clone, damaged repository). */
  | 'missingObjects'
  | 'aborted' | 'error';

export interface HistoryResult {
  /** Path → facts. Order is not meaningful. With `paths` given to the walk, only those paths appear. */
  files: Map<string, FileHistory>;
  /** Most commits first. Indices are only meaningful within this result. */
  contributors: Contributor[];
  /** The commit the walk started from. */
  headOid: string;
  /** The oldest commit the walk has processed (in walk order); null before the first chunk lands. */
  reachedOid: string | null;
  /** Commit time of `reachedOid` in seconds: the facts cover the history back to this moment. */
  reachedTime: number | null;
  /** Commits visited, including merges that were skipped. */
  commitsWalked: number;
  /** True when every commit reachable from `headOid` (under `merges`) is accounted for. */
  complete: boolean;
  /** True when `lastModified` is final for every current file (Recency needs nothing more). */
  recencyComplete: boolean;
  merges: MergeMode;
  /** Fingerprint of the .mailmap the contributors were resolved with ('' for none). */
  mailmapHash: string;
  /** Set when `complete` is false. */
  stoppedBy?: HistoryStop;
  /** Detail for stoppedBy 'error'. */
  error?: string;
}

/** HistoryResult as plain JSON, for snapshots: parallel arrays over `paths`, which are sorted. */
export interface HistoryJson {
  version: 1;
  merges: MergeMode;
  mailmapHash: string;
  headOid: string;
  reachedOid: string | null;
  reachedTime: number | null;
  commitsWalked: number;
  complete: boolean;
  recencyComplete: boolean;
  stoppedBy?: HistoryStop;
  error?: string;
  contributors: Contributor[];
  paths: string[];
  commits: number[];
  lastModified: number[];
  firstSeen: number[];
  lastAuthor: number[];
  lastOidPrefix: number[];
  /** Per path: [contributor, commits, contributor, commits, …]. */
  authors: number[][];
}

export type HistoryUnavailableReason =
  /** The pool has no repo set. */
  | 'no-repo'
  /** A plain folder, or a `.git` that is not a directory inside the picked folder. */
  | 'no-git'
  /** No commit yet. */
  | 'empty'
  /** SHA-256 object format. */
  | 'unsupported'
  /** The start commit cannot be read. */
  | 'unreadable';

export interface HistoryUnavailable { reason: HistoryUnavailableReason; message: string }

// ---- planner task ----

/** One commit as the planner hands it to a chunk. */
export interface PlannedCommit {
  oid: string;
  /** Commit time in seconds: what the walk is ordered by. */
  date: number;
  tree: string;
  /** Tree of the first parent; null for a root commit. */
  parentTree: string | null;
  /**
   * Who wrote it. From the planner: an index into PlanPage.authors. To a chunk: the driver's author
   * id. −1 when the commit object was not read (commit-graph), in which case the chunk reads it.
   */
  author: number;
  /** Author time in seconds; 0 when `author` is −1. */
  time: number;
  isMerge: boolean;
  /** The first parent is not on disk (shallow boundary): there is nothing to diff against. */
  boundary?: true;
}

/** A commit waiting in the planner's queue. */
export interface FrontierEntry {
  oid: string;
  /** Commit time: the walk order. */
  date: number;
  tree: string;
  parents: string[];
  /** "Name <email>", or null when read from the commit-graph. */
  ident: string | null;
  authorTime: number;
}

/** Where a later page continues: the queue, and every commit ever queued (see SeenSet). */
export interface PlanFrontier {
  entries: FrontierEntry[];
  seen: ArrayBuffer;
  seenCount: number;
}

export interface PlanInput {
  /** First page only: the commit (or tag) to start from. Default HEAD. */
  start?: string | null;
  /** Later pages: what the previous page returned. */
  frontier?: PlanFrontier | null;
  /**
   * Incremental walk: return only commits that are not reachable from this one. Pass it on every
   * page until the page's `stop` is 'reached' or 'abandoned'.
   */
  stopAt?: string | null;
  /**
   * First page, with stopAt: the mailmap fingerprint of the saved result. When the working tree's
   * .mailmap no longer matches, stopAt is ignored and the page's `stop` is 'abandoned'.
   */
  sinceMailmap?: string;
  /** Follow first parents only (merges: 'firstParent'). */
  firstParentOnly: boolean;
  /** Most commits an ordinary page may return. */
  limit: number;
  /**
   * Most commits the walk may still take in total (the commit cap less what was planned). The page
   * that limits an incremental walk is bounded by this instead of `limit`.
   */
  remaining: number;
  /** Read parents, tree and date from objects/info/commit-graph when it exists. Default true. */
  useCommitGraph?: boolean;
  /** End the page after about this long. Default config.scheduler.taskTargetMs. */
  budgetMs?: number;
}

/**
 * - none:      no stopAt was given.
 * - searching: stopAt has not been met yet; the commits returned are valid either way.
 * - reached:   stopAt is an ancestor of the start and the walk is finished: every commit returned
 *              (on this and earlier pages) is newer than it.
 * - abandoned: the walk cannot be limited (cap hit first, or a commit already returned turned out to
 *              be an ancestor of stopAt). It continues as an ordinary full walk; drop the old result.
 */
export type PlanStop = 'none' | 'searching' | 'reached' | 'abandoned';

export interface PlanPage {
  /** Set on the first page when there is no history to walk; everything else is then empty. */
  unavailable?: HistoryUnavailable;
  /** First page: the resolved start commit. */
  headOid: string | null;
  /** First page: text of `.mailmap` at the working tree root, or null, and its fingerprint. */
  mailmap?: string | null;
  mailmapHash?: string;
  shallow: boolean;
  /** Newest first. */
  commits: PlannedCommit[];
  /** "Name <email>" strings that `commits[].author` indexes. */
  authors: string[];
  /** Null when the walk is finished. */
  frontier: PlanFrontier | null;
  stop: PlanStop;
  /** Parent commits that are not on disk. */
  missingParents: number;
  usedCommitGraph: boolean;
  /** Date.now() at the start and end of the task, for the driver's time budget. */
  startedAt: number;
  endedAt: number;
}

// ---- chunk task ----

export interface ChunkInput {
  /** Consecutive commits, newest first. */
  commits: PlannedCommit[];
  merges: MergeMode;
}

/**
 * Per-path totals of one chunk. Author ids are the driver's ids as given in the input; an author the
 * chunk had to read itself is −(i+1), where i indexes `localAuthors`.
 */
export interface ChunkOutput {
  paths: string[];
  /** Per path: commits that touched it. */
  commits: Uint32Array;
  /** Per path: newest and oldest author time. */
  last: Float64Array;
  first: Float64Array;
  /** Per path: author id and oid prefix of the commit that set `last`. */
  lastAuthor: Int32Array;
  lastOidPrefix: Uint32Array;
  /** Triples [path index, author id, commits]. */
  authorPairs: Int32Array;
  /** Per author of a counted commit: id, commits, newest author time. */
  authorIds: Int32Array;
  authorCommits: Uint32Array;
  authorLast: Float64Array;
  /** "Name <email>" of authors read by the chunk. */
  localAuthors: string[];
  /** Commits in the input. */
  walked: number;
  mergesSkipped: number;
  /** Commits left out because a tree (or the commit itself) is not on disk. */
  missing: number;
  startedAt: number;
  endedAt: number;
}

export const HISTORY_PLAN_TASK = 'history.plan';
export const HISTORY_CHUNK_TASK = 'history.chunk';
export const HISTORY_GROUP = 'history';
