// The history walk as the pipeline runs it (PLAN.md §3.1, §6.5): started as soon as the manifest is
// known, on whatever workers the parse leaves idle, and never part of the reveal gate. Its facts
// become the Recency, Ownership and Knowledge risk layers, proposed as chunks land once the map has
// units to attach them to, and the contributor table when the walk ends. Lead-owned.
import { historyLayers, type HistoryLayerState } from '../analysis';
import type { Config } from '../config';
import type { ComputePool } from '../contracts/compute';
import type { PipelineEvents } from '../contracts/pipeline';
import type { ModelStore } from '../contracts/store';
import { runHistoryWalk, type Contributor, type HistoryOutcome, type HistoryProgress, type HistoryResult } from '../history';
import type { ModelPatch } from '../model/types';
import { loadSavedHistory, saveHistory, type PipelinePersistence } from './persist';

export interface HistoryRunOptions {
  config: Config;
  pool: ComputePool;
  store: ModelStore;
  emit<E extends keyof PipelineEvents>(evt: E, e: PipelineEvents[E]): void;
  persist?: PipelinePersistence;
  /** RepoMeta.id: the key the walk's facts are stored under. */
  repoId: string;
  /** The files on the map. Facts are kept for these, and coverage is measured against them. */
  paths: string[];
  /**
   * Walk now (the default). False for a map loaded with its history layers already in it: nothing
   * runs until "Load full history" asks.
   */
  start?: boolean;
  /** A layer finished (Recency early, all three at the end): the snapshot is worth writing again. */
  onLayersSaved?(): void;
}

export interface HistoryRun {
  /** The last finished walk's facts; null before the first walk ends and when history is unavailable. */
  readonly result: HistoryResult | null;
  /** How the last finished walk ended. */
  readonly outcome: HistoryOutcome | null;
  /** Settles when the walk in progress has ended and its layers are in the store. Never rejects. */
  readonly done: Promise<void>;
  /**
   * The map has units now, or its structure changed (the first structure batch, "Apply", an
   * Update): propose the layers from the newest facts. Before the first call nothing is proposed.
   */
  refresh(): void;
  /** "Load full history": walk again without the commit and time caps. Resolves when it has ended. */
  loadFull(): Promise<void>;
  dispose(): void;
}

/** Rows of the contributor table for a finished walk: ids are the walk's contributor indices. */
function contributorOps(store: ModelStore, contributors: readonly Contributor[]): ModelPatch[] {
  const table = store.replica.table('contributor');
  const rows = (list: readonly Contributor[]) => ({
    ids: list.map((c) => String(c.id)),
    cols: { name: list.map((c) => c.name), emails: list.map((c) => c.emails.join(',')), commits: list.map((c) => c.commits) },
  });
  const known = contributors.filter((c) => table.has(String(c.id)));
  const fresh = contributors.filter((c) => !table.has(String(c.id)));
  const keep = new Set(contributors.map((c) => String(c.id)));
  const gone = table.slots().map((s) => table.ids[s]!).filter((id) => !keep.has(id));
  const ops: ModelPatch[] = [];
  if (known.length) ops.push({ op: 'update', kind: 'contributor', rows: rows(known) });
  if (fresh.length) ops.push({ op: 'add', kind: 'contributor', rows: rows(fresh) });
  if (gone.length) ops.push({ op: 'remove', kind: 'contributor', rows: { ids: gone, cols: {} } });
  return ops;
}

export function startHistory(opts: HistoryRunOptions): HistoryRun {
  const { config, pool, store, emit, persist, repoId, paths } = opts;
  /** The newest facts, final or partial, with the progress they came with. */
  let latest: { result: HistoryResult; info: HistoryProgress | null; final: boolean } | null = null;
  let layerState: HistoryLayerState | undefined;
  let unitsReady = false;
  let recencyDone = false;
  let result: HistoryResult | null = null;
  let outcome: HistoryOutcome | null = null;
  let controller = new AbortController();
  let disposed = false;

  function propose(): void {
    if (!latest || !unitsReady || disposed) return;
    const { result: facts, info, final } = latest;
    const walked = info ? (info.totalKnown ? info.commitsWalked / info.totalKnown : info.coverage) : 0;
    const input = {
      contributors: facts.contributors, files: facts.files, complete: facts.complete, recencyComplete: facts.recencyComplete,
      coverage: facts.complete ? 1 : Math.min(1, Math.max(0, walked || 0)), now: Date.now() / 1000,
    };
    try {
      const layers = historyLayers(input, store.replica, config, layerState);
      const ops: ModelPatch[] = [...layers.ops];
      if (final) {
        ops.push(...contributorOps(store, facts.contributors));
        ops.push({ op: 'meta', value: { history: { reachedOid: facts.reachedOid, commitsWalked: facts.commitsWalked, complete: facts.complete } } });
      }
      store.propose(ops);
      layerState = layers.state;
    } catch (err) {
      // Overlays colour the map and never break it: a rejected proposal leaves the layers as they were.
      emit('error', { message: `History overlays could not be updated: ${String((err as Error)?.message ?? err)}`, fatal: false });
      return;
    }
    if (final || (facts.recencyComplete && !recencyDone)) {
      recencyDone = true;
      opts.onLayersSaved?.();
    }
  }

  async function walk(loadFull: boolean, previous: HistoryResult | null): Promise<void> {
    const signal = controller.signal;
    const since = previous ?? (await loadSavedHistory(persist, repoId));
    if (signal.aborted) return;
    let lastInfo: HistoryProgress | null = null;
    const ended = await runHistoryWalk(pool, config, {
      paths, since, loadFull, signal,
      onProgress(partial, info) {
        if (signal.aborted) return;
        lastInfo = info;
        emit('progress', { subsystem: 'history', done: info.commitsWalked, total: info.totalKnown ?? Math.max(info.commitsWalked, 1) });
        latest = { result: partial, info, final: false };
        propose();
      },
    });
    // A walk cut off by "Load full history" or by closing the map: the one that replaced it reports.
    if (signal.aborted) return;
    outcome = ended;
    if (!ended.available) {
      emit('notice', { kind: 'no-history', reason: ended.message });
      return;
    }
    result = ended.result;
    latest = { result: ended.result, info: lastInfo, final: true };
    propose();
    if (ended.result.stoppedBy !== 'error') await saveHistory(persist, repoId, ended.result);
  }

  // The driver never rejects; this guards the code around it, so `done` can be awaited blindly.
  const guarded = (run: Promise<void>): Promise<void> => run.catch((err) => {
    emit('error', { message: `The history walk stopped: ${String(err?.message ?? err)}`, fatal: false });
  });

  let done = opts.start === false ? Promise.resolve() : guarded(walk(false, null));

  return {
    get result() { return result; },
    get outcome() { return outcome; },
    get done() { return done; },
    refresh() {
      unitsReady = true;
      propose();
    },
    loadFull() {
      if (disposed) return Promise.resolve();
      controller.abort();
      controller = new AbortController();
      const before = done;
      done = guarded(before.then(() => walk(true, result)));
      return done;
    },
    dispose() {
      disposed = true;
      controller.abort();
    },
  };
}
