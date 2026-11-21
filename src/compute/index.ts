// Public surface of src/compute. Package 1B owns this folder.
import type { Config } from '../config';
import type { ComputePool, TaskDef } from '../contracts/compute';
import type { RepoAccess, RepoLocator } from '../contracts/git';

export interface WorkerPoolOptions {
  config: Config;
  /** Override the computed pool size. */
  size?: number;
}

/** Browser pool backed by Web Workers running src/compute/worker.ts. */
export function createWorkerPool(_opts: WorkerPoolOptions): ComputePool {
  throw new Error('not implemented: createWorkerPool (package 1B)');
}

export interface InlinePoolOptions {
  config: Config;
  /** Tasks to serve. */
  tasks: TaskDef[];
  /** Opens the repo a locator points at (Node: openNodeRepoAccess; tests: an in-memory fake). */
  openRepo?: (locator: RepoLocator) => Promise<RepoAccess>;
  /** Simulated worker count; scheduling still follows lanes. Default 1. */
  size?: number;
}

/** In-process pool with the same scheduling rules, for Node scripts and tests. */
export function createInlinePool(_opts: InlinePoolOptions): ComputePool {
  throw new Error('not implemented: createInlinePool (package 1B)');
}

/** Pool size (PLAN.md §3): clamp(round(cores × scheduler.workerShare), 1, maxWorkers), also capped by scheduler.memoryCapMB / memoryPerWorkerMB and by device memory. */
export function poolSize(_config: Config, _hardwareConcurrency: number, _deviceMemoryGb?: number): number {
  throw new Error('not implemented: poolSize (package 1B)');
}
