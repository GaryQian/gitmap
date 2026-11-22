// The driver of the history walk (PLAN.md §3.1, §6.5). It runs in the coordinator: asks the planner
// task for pages of commits, cuts them into chunks of consecutive commits, runs the chunks on the
// pool, merges what comes back in whatever order it lands, and reports partial results as it goes.
import type { Config } from '../config';
import type { ComputePool, Lane } from '../contracts/compute';
import { parseMailmap } from './mailmap';
import { HistoryAccumulator, type ResultMeta } from './merge';
import {
  HISTORY_CHUNK_TASK, HISTORY_GROUP, HISTORY_PLAN_TASK,
  type ChunkInput, type ChunkOutput, type HistoryResult, type HistoryStop, type HistoryUnavailableReason,
  type MergeMode, type PlanFrontier, type PlanInput, type PlanPage, type PlannedCommit,
} from './types';

export interface HistoryProgress {
  /** Commits processed so far (including those of the saved result on an incremental walk). */
  commitsWalked: number;
  /** How many commits this walk will process, once the planner has finished. */
  totalKnown?: number;
  /** Share of the current files seen at least once: 0–1. 0 when `paths` was not given. */
  coverage: number;
}

export interface HistoryWalkOptions {
  /** The current files. Facts are kept only for these, and coverage is measured against them. */
  paths?: Iterable<string> | null;
  /** Lane the tasks are queued in. Default 'otherOverlays'; the coordinator moves the group between lanes. */
  lane?: Lane;
  /** Task group. Default 'history'. */
  group?: string;
  /** Commit (or tag) to start from. Default HEAD. */
  startOid?: string | null;
  /**
   * A saved result: only commits newer than its `headOid` are walked and merged into it. Ignored
   * (a full walk runs) when it was made with another merge setting, was cut short by an abort or an
   * error, or when its head is not an ancestor of the start commit.
   */
  since?: HistoryResult | null;
  /** Stop after this many commits. Default config.history.maxCommits. */
  maxCommits?: number;
  /** Stop after this much time spent running history tasks. Default config.history.timeBudgetSeconds. */
  timeBudgetSeconds?: number;
  /** "Load full history": ignore both caps (and a saved result that is itself incomplete). */
  loadFull?: boolean;
  /** Default config.history.merges. */
  merges?: MergeMode;
  /** Abort: the walk resolves at once with what it has, `complete: false`, `stoppedBy: 'aborted'`. */
  signal?: AbortSignal;
  /** Called at a throttled rate with an independent copy of the facts so far, and once with the final result. */
  onProgress?: (partial: HistoryResult, info: HistoryProgress) => void;
  /** Least time between two onProgress calls. */
  progressIntervalMs?: number;
  /** Most commits per planner page. Default: bounded by time only (config.scheduler.taskTargetMs). */
  planPageCommits?: number;
  /** Use objects/info/commit-graph when present. Default true. */
  useCommitGraph?: boolean;
}

export interface HistoryWalkStats {
  planPages: number;
  chunks: number;
  usedCommitGraph: boolean;
  /** True when the saved result was reused. */
  incremental: boolean;
  /** Time during which at least one history task was running. This is what the time budget counts. */
  activeMs: number;
  wallMs: number;
}

export type HistoryOutcome =
  | { available: true; result: HistoryResult; stats: HistoryWalkStats }
  | { available: false; reason: HistoryUnavailableReason; message: string };

/** Until config.json has history.progressIntervalMs (requested): how often partial results are reported. */
const DEFAULT_PROGRESS_INTERVAL_MS = 250;
/** Building a partial result may take at most this share of the time between two reports. */
const PROGRESS_COST_SHARE = 0.1;
/** Chunks kept queued or running per worker: enough that no worker waits for the planner, few enough that a cap takes effect quickly. */
const CHUNKS_PER_WORKER = 2;
const NO_LIMIT = Number.MAX_SAFE_INTEGER;

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** A saved result can be extended only if what it holds is a gap-free run of the newest commits. */
function reusable(since: HistoryResult | null | undefined, merges: MergeMode, loadFull: boolean): HistoryResult | null {
  if (!since || since.merges !== merges || !since.headOid) return null;
  if (since.stoppedBy === 'aborted' || since.stoppedBy === 'error') return null;
  if (loadFull && !since.complete) return null;
  return since;
}

/**
 * Walk the history of the repo the pool has open and return per-file facts. Never rejects: a repo
 * without readable history gives `{ available: false, reason }`, and a walk that fails part-way
 * gives what it has with `complete: false`.
 */
export function runHistoryWalk(pool: ComputePool, config: Config, opts: HistoryWalkOptions = {}): Promise<HistoryOutcome> {
  const startedAt = now();
  const merges = opts.merges ?? (config.history.merges as MergeMode);
  const loadFull = opts.loadFull === true;
  const maxCommits = loadFull ? NO_LIMIT : Math.max(1, opts.maxCommits ?? config.history.maxCommits);
  const budgetMs = loadFull ? Infinity : (opts.timeBudgetSeconds ?? config.history.timeBudgetSeconds) * 1000;
  const chunkSize = Math.max(1, Math.floor(config.scheduler.historyChunkCommits));
  const maxInFlight = Math.max(1, pool.size) * CHUNKS_PER_WORKER;
  const lane = opts.lane ?? 'otherOverlays';
  const group = opts.group ?? HISTORY_GROUP;
  const progressInterval = opts.progressIntervalMs
    ?? (config.history as { progressIntervalMs?: number }).progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS;
  const since = reusable(opts.since, merges, loadFull);

  const acc = new HistoryAccumulator(opts.paths);
  let headOid = '';
  let frontier: PlanFrontier | null = null;
  let firstPage = true;
  let planning = false;
  /** No further page will be asked for. */
  let planDone = false;
  /** The planner reached the end of history (or the saved head). */
  let exhausted = false;
  let planned = 0;
  let stopAt: string | null = since ? since.headOid : null;
  let sinceState: 'none' | 'pending' | 'merged' | 'dropped' = since ? 'pending' : 'none';
  const buffer: PlannedCommit[] = [];
  let inFlight = 0;
  const chunkLastOid: string[] = [];
  const chunkDone: boolean[] = [];
  /** Chunks [0, prefix) are merged: the facts cover a gap-free run of commits up to there. */
  let prefix = 0;
  let highestMerged = -1;
  /** Once every current file has been seen: the number of leading chunks that must be merged for Recency to be final. */
  let recencyNeeds: number | null = null;
  let walked = 0;
  let shallow = false;
  let missing = 0;
  let stoppedBy: HistoryStop | undefined;
  let error: string | undefined;
  /** Nothing more is submitted; the walk ends when what is running has come back. */
  let halted = false;
  let settled = false;
  const stats: HistoryWalkStats = { planPages: 0, chunks: 0, usedCommitGraph: false, incremental: false, activeMs: 0, wallMs: 0 };
  let coveredUntil = 0;
  let lastReport = 0;
  let reportGap = progressInterval;

  let resolve!: (outcome: HistoryOutcome) => void;
  const promise = new Promise<HistoryOutcome>((r) => { resolve = r; });

  /** Task intervals are merged into one timeline, so time spent queued behind other lanes is not counted. */
  const noteActive = (from: number, to: number): void => {
    if (to <= coveredUntil) return;
    stats.activeMs += to - Math.max(from, coveredUntil);
    coveredUntil = to;
  };

  const merged = (): boolean => sinceState === 'merged';
  const allChunksIn = (): boolean => exhausted && buffer.length === 0 && prefix === stats.chunks;
  const meta = (final: boolean): ResultMeta => {
    const all = allChunksIn();
    const sinceComplete = merged() ? since!.complete : true;
    const complete = final && all && !stoppedBy && !shallow && missing === 0 && sinceComplete;
    let recencyComplete: boolean;
    if (merged()) recencyComplete = all && (since!.recencyComplete || acc.allSeen());
    else recencyComplete = recencyNeeds !== null && prefix >= recencyNeeds;
    const m: ResultMeta = {
      headOid,
      reachedOid: (merged() ? since!.reachedOid : null) ?? (prefix > 0 ? chunkLastOid[prefix - 1] : null),
      commitsWalked: walked + (merged() ? since!.commitsWalked : 0),
      complete,
      recencyComplete: complete || recencyComplete,
      merges,
    };
    if (final && !complete) {
      m.stoppedBy = stoppedBy ?? (shallow ? 'shallow' : missing > 0 ? 'missingObjects' : merged() ? since!.stoppedBy : undefined) ?? 'error';
      if (error) m.error = error;
    }
    return m;
  };
  const info = (r: HistoryResult): HistoryProgress => {
    const p: HistoryProgress = { commitsWalked: r.commitsWalked, coverage: acc.coverage() };
    if (planDone && !halted) p.totalKnown = planned + (merged() ? since!.commitsWalked : 0);
    return p;
  };

  const report = (): void => {
    // While it is not known whether the saved result can be kept, a partial would be misleading either way.
    if (!opts.onProgress || sinceState === 'pending') return;
    const t = now();
    if (t - lastReport < reportGap) return;
    const partial = acc.snapshot(meta(false));
    lastReport = now();
    reportGap = Math.max(progressInterval, (lastReport - t) / PROGRESS_COST_SHARE);
    try { opts.onProgress(partial, info(partial)); } catch (e) { console.error('[history] onProgress threw', e); }
  };

  const finish = (): void => {
    if (settled) return;
    settled = true;
    opts.signal?.removeEventListener('abort', onAbort);
    if (sinceState === 'pending') sinceState = 'dropped';
    const result = acc.snapshot(meta(true));
    stats.incremental = merged();
    stats.wallMs = now() - startedAt;
    try { opts.onProgress?.(result, info(result)); } catch (e) { console.error('[history] onProgress threw', e); }
    resolve({ available: true, result, stats });
  };

  const halt = (why: HistoryStop, message?: string): void => {
    if (halted) return;
    halted = true;
    stoppedBy = why;
    error = message;
  };

  function onAbort(): void {
    halt('aborted');
    finish();
  }

  const fail = (e: unknown): void => {
    const message = e instanceof Error ? e.message : String(e);
    // the pool rejects with these when the coordinator cancels the group or shuts down
    if (message === 'cancelled' || message === 'pool disposed') halt('aborted');
    else halt('error', message);
  };

  const submitChunk = (commits: PlannedCommit[]): void => {
    const index = stats.chunks++;
    chunkLastOid[index] = commits[commits.length - 1].oid;
    inFlight++;
    pool.run<ChunkOutput, ChunkInput>({ type: HISTORY_CHUNK_TASK, lane, group, input: { commits, merges } }).then((out) => {
      inFlight--;
      if (settled) return;
      noteActive(out.startedAt, out.endedAt);
      acc.mergeChunk(out);
      walked += out.walked;
      missing += out.missing;
      chunkDone[index] = true;
      while (chunkDone[prefix]) prefix++;
      if (index > highestMerged) highestMerged = index;
      if (recencyNeeds === null && acc.allSeen()) recencyNeeds = highestMerged + 1;
      // The budget only matters while there is work that has not been handed out yet.
      if (stats.activeMs >= budgetMs && !(planDone && buffer.length === 0)) halt('timeBudget');
      report();
      pump();
    }, (e) => {
      inFlight--;
      if (settled) return;
      fail(e);
      pump();
    });
  };

  const onPage = (page: PlanPage): void => {
    planning = false;
    if (settled) return;
    noteActive(page.startedAt, page.endedAt);
    if (page.unavailable) {
      settled = true;
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ available: false, reason: page.unavailable.reason, message: page.unavailable.message });
      return;
    }
    if (firstPage) {
      firstPage = false;
      headOid = page.headOid ?? '';
      acc.setMailmap(page.mailmap ? parseMailmap(page.mailmap) : null);
    }
    shallow ||= page.shallow;
    missing += page.missingParents;
    stats.usedCommitGraph ||= page.usedCommitGraph;
    if (sinceState === 'pending') {
      if (page.stop === 'reached') {
        acc.absorb(since!);
        sinceState = 'merged';
      } else if (page.stop === 'abandoned' || !page.frontier) {
        // the saved head is not behind this one (history was rewritten, or too far back): start over
        sinceState = 'dropped';
        stopAt = null;
      }
    }
    const ids = page.authors.map((ident) => acc.rawAuthor(ident));
    for (const c of page.commits) {
      if (c.author >= 0) c.author = ids[c.author];
      buffer.push(c);
    }
    planned += page.commits.length;
    frontier = page.frontier;
    if (!frontier) {
      exhausted = true;
      planDone = true;
    } else if (planned >= maxCommits) {
      planDone = true;
      if (!halted) stoppedBy = 'maxCommits';
    }
    pump();
  };

  const startPlan = (): void => {
    planning = true;
    stats.planPages++;
    const input: PlanInput = {
      frontier,
      stopAt,
      firstParentOnly: merges === 'firstParent',
      limit: opts.planPageCommits ?? NO_LIMIT,
      remaining: maxCommits - planned,
      useCommitGraph: opts.useCommitGraph,
    };
    if (firstPage) input.start = opts.startOid ?? null;
    const transfer = frontier ? [frontier.seen] : undefined;
    frontier = null;
    pool.run<PlanPage, PlanInput>({ type: HISTORY_PLAN_TASK, lane, group, input, transfer }).then(onPage, (e) => {
      planning = false;
      if (settled) return;
      fail(e);
      pump();
    });
  };

  function pump(): void {
    if (settled) return;
    if (!halted) {
      while (inFlight < maxInFlight && (buffer.length >= chunkSize || (planDone && buffer.length > 0))) {
        submitChunk(buffer.splice(0, chunkSize));
      }
      if (!planDone && !planning && buffer.length < chunkSize * maxInFlight) startPlan();
    }
    if (inFlight === 0 && !planning && (halted || (planDone && buffer.length === 0))) finish();
  }

  if (opts.signal?.aborted) {
    halt('aborted');
    finish();
  } else {
    opts.signal?.addEventListener('abort', onAbort);
    pump();
  }
  return promise;
}
