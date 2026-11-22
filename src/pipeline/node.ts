// Node-only entry: the same pipeline, headless (PLAN.md §12.1 "Building a demo", IMPLEMENTATION.md §3).
// Parse → resolve → cluster → settle → history layers → model, with an in-process pool and physics engine.
import { createInlinePool } from '../compute';
import type { Config } from '../config';
import type { FactsCache } from '../contracts/ingest';
import type { PhysicsEngine, SettleReport } from '../contracts/physics';
import type { PipelineEvents, RepoSource, SearchHit } from '../contracts/pipeline';
import type { ModelStore } from '../contracts/store';
import { openNodeRepoAccess } from '../git/node';
import { createModelStore } from '../model';
import type { RepoModel } from '../model/types';
import { memoryBlobStore, openPersistence } from '../persist';
import { createPhysicsEngine } from '../physics';
import { runSource, type PipelineDeps, type PipelineState } from './core';
import type { PipelinePersistence } from './persist';
import { afterReveal } from './post';
import { createPipelineSearch } from './search';
import { allTasks } from './tasks';

export interface HeadlessResult {
  store: ModelStore;
  physics: PhysicsEngine;
  state: PipelineState;
  /** The finished model with its settled layout and, for a git folder, its history layers. */
  model: RepoModel;
  /** The same path search the app's Session.search answers with. */
  search(query: string, limit?: number): SearchHit[];
  dispose(): void;
}

/** Local storage for a headless run: what the browser coordinator gets from src/persist. */
export interface HeadlessPersistence extends PipelinePersistence {
  /** Parse facts by blob id. */
  facts?: FactsCache;
}

export interface HeadlessOptions {
  /** Keep the 30-second escape hatch. Default false: a headless run always waits for the full structure. */
  escapeHatch?: boolean;
  /** Simulated worker count for the in-process pool. */
  workers?: number;
  /**
   * Storage to read and write. Default none: nothing is cached, saved or reloaded. With it, a second
   * run on the same folder comes back from the stored snapshot (`state.fromSnapshot`).
   */
  persist?: HeadlessPersistence;
  /** Walk git history for the overlay layers and wait for it before returning. Default true. */
  history?: boolean;
  onEvent?<E extends keyof PipelineEvents>(evt: E, payload: PipelineEvents[E]): void;
}

/** In-memory storage that lasts as long as the object: for tests, and for scripts that run a folder twice. */
export async function memoryPersistence(): Promise<HeadlessPersistence> {
  const { snapshots, registry, facts } = await openPersistence({ memory: true });
  return { snapshots, registry, facts, aux: memoryBlobStore() };
}

/** Run the whole pipeline in this process and return the model. */
export async function runHeadless(source: RepoSource, baseConfig: Config, opts: HeadlessOptions = {}): Promise<HeadlessResult> {
  const config: Config = opts.escapeHatch ? baseConfig : { ...baseConfig, reveal: { ...baseConfig.reveal, maxWaitSeconds: 0 } };
  const store = createModelStore();
  const openRepo = async (locator: import('../contracts/git').RepoLocator) => {
    if (locator.kind !== 'node') throw new Error(`headless pipeline cannot open a '${locator.kind}' locator`);
    return openNodeRepoAccess(locator.rootPath);
  };
  const pool = createInlinePool({ config, tasks: allTasks, openRepo, size: opts.workers ?? 1 });
  const physics = createPhysicsEngine({ config, capacity: { units: 4096, districts: 1024, cities: 256 } });
  store.subscribe((batch) => physics.applyBatch(batch));
  const search = createPipelineSearch(store);
  // No worker runs the scheduler here: the animated re-layout moves only while it is stepped.
  const relayout = async (maxMs: number): Promise<SettleReport> => {
    const ended: { report: SettleReport | null } = { report: null };
    void physics.relayout(maxMs).then((r) => { ended.report = r; });
    while (!ended.report) {
      physics.step(config.physics.sliceMs);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return ended.report;
  };
  const deps: PipelineDeps = {
    config, pool, store, openRepo, search,
    physics: { settle: (ms) => physics.settle(ms), relayout, loadLayout: (l) => physics.loadLayout(l), getLayout: () => physics.getLayout() },
    emit: (evt, payload) => opts.onEvent?.(evt, payload),
    cache: opts.persist?.facts,
    persist: opts.persist,
    history: opts.history,
  };
  const state = await runSource(source, deps);
  await afterReveal(deps, state);
  // Nothing follows a headless run, so everything that would trickle in after the reveal is waited for.
  await state.history?.done;
  if (state.saver) await state.saver.flush();
  const model = store.toModel(await physics.getLayout());
  return {
    store, physics, state, model,
    search: (query, limit) => search.search(query, limit),
    dispose() {
      state.history?.dispose();
      state.saver?.dispose();
      search.dispose();
      pool.dispose();
      physics.dispose();
    },
  };
}
