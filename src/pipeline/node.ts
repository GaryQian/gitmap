// Node-only entry: the same pipeline, headless (PLAN.md §12.1 "Building a demo", IMPLEMENTATION.md §3).
// Parse → resolve → cluster → settle → model, with an in-process pool and physics engine.
import { createInlinePool } from '../compute';
import type { Config } from '../config';
import type { PhysicsEngine } from '../contracts/physics';
import type { PipelineEvents, RepoSource } from '../contracts/pipeline';
import type { ModelStore } from '../contracts/store';
import { openNodeRepoAccess } from '../git/node';
import { createModelStore } from '../model';
import type { RepoModel } from '../model/types';
import { createPhysicsEngine } from '../physics';
import { runSource, type PipelineState } from './core';
import { allTasks } from './tasks';

export interface HeadlessResult {
  store: ModelStore;
  physics: PhysicsEngine;
  state: PipelineState;
  /** The finished model with its settled layout. */
  model: RepoModel;
  dispose(): void;
}

export interface HeadlessOptions {
  /** Keep the 30-second escape hatch. Default false: a headless run always waits for the full structure. */
  escapeHatch?: boolean;
  /** Simulated worker count for the in-process pool. */
  workers?: number;
  onEvent?<E extends keyof PipelineEvents>(evt: E, payload: PipelineEvents[E]): void;
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
  const state = await runSource(source, {
    config, pool, store, openRepo,
    physics: { settle: (ms) => physics.settle(ms), loadLayout: (l) => physics.loadLayout(l), getLayout: () => physics.getLayout() },
    emit: (evt, payload) => opts.onEvent?.(evt, payload),
  });
  const model = store.toModel(await physics.getLayout());
  return { store, physics, state, model, dispose() { pool.dispose(); physics.dispose(); } };
}
