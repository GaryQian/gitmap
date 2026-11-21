// Public surface of src/compute. Package 1B owns this folder.
import type { Config } from '../config';
import type { ComputePool, TaskDef } from '../contracts/compute';
import type { RepoAccess, RepoLocator } from '../contracts/git';
import { createInlineBackend } from './inline';
import { createPool } from './pool';
import { createWorkerBackend } from './workerPool';

export { Scheduler } from './scheduler';
export type { Assignment, ParkLevel, ScheduledTask, SchedulerOptions } from './scheduler';
export { collectTasks } from './tasks';

export interface WorkerPoolOptions {
  config: Config;
  /** Override the computed pool size. */
  size?: number;
}

/** Browser pool backed by Web Workers running src/compute/worker.ts. */
export function createWorkerPool(opts: WorkerPoolOptions): ComputePool {
  const nav = (typeof navigator === 'undefined' ? {} : navigator) as { hardwareConcurrency?: number; deviceMemory?: number };
  const size = opts.size !== undefined
    ? Math.max(1, Math.floor(opts.size))
    : poolSize(opts.config, nav.hardwareConcurrency ?? 1, nav.deviceMemory);
  return createPool(opts.config, createWorkerBackend(opts.config, size));
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
export function createInlinePool(opts: InlinePoolOptions): ComputePool {
  return createPool(opts.config, createInlineBackend(opts));
}

/** Pool size (PLAN.md §3): clamp(round(cores × scheduler.workerShare), 1, maxWorkers), also capped by scheduler.memoryCapMB / memoryPerWorkerMB and by device memory. */
export function poolSize(config: Config, hardwareConcurrency: number, deviceMemoryGb?: number): number {
  const s = config.scheduler;
  const cores = Number.isFinite(hardwareConcurrency) && hardwareConcurrency > 0 ? hardwareConcurrency : 1;
  let n = Math.min(Math.round(cores * s.workerShare), s.maxWorkers);
  n = Math.min(n, Math.floor(s.memoryCapMB / s.memoryPerWorkerMB));
  if (deviceMemoryGb !== undefined && Number.isFinite(deviceMemoryGb) && deviceMemoryGb > 0) {
    // The pool may use the same share of the device's memory as it uses of its cores, until the
    // config has a value of its own for this (scheduler.deviceMemoryShare).
    const share = (s as { deviceMemoryShare?: number }).deviceMemoryShare ?? s.workerShare;
    n = Math.min(n, Math.floor((deviceMemoryGb * 1024 * share) / s.memoryPerWorkerMB));
  }
  return Math.max(1, n);
}
