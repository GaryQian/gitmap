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
  const nav = (typeof navigator === 'undefined' ? {} : navigator) as {
    hardwareConcurrency?: number; deviceMemory?: number; platform?: string; userAgentData?: { platform?: string };
  };
  // Apple Silicon has no simultaneous multithreading: on macOS the reported cores are physical
  // cores, and halving them by scheduler.threadsPerCore starves the pool (an 18-core M-series
  // machine would get 6 workers). Chromium reports "MacIntel" as the platform on ARM Macs too.
  const smt = !(nav.userAgentData?.platform === 'macOS' || /Mac/.test(nav.platform ?? ''));
  const size = opts.size !== undefined
    ? Math.max(1, Math.floor(opts.size))
    : poolSize(opts.config, nav.hardwareConcurrency ?? 1, nav.deviceMemory, smt);
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

/**
 * Pool size (PLAN.md §3): clamp(round(cores × scheduler.workerShare), 1, maxWorkers), also capped by
 * the estimated physical cores less the app's busy threads and a reserve, by scheduler.memoryCapMB /
 * memoryPerWorkerMB and by device memory. Never below 1. `smt: false` says the reported cores are
 * already physical (macOS), so scheduler.threadsPerCore does not divide them.
 */
export function poolSize(config: Config, hardwareConcurrency: number, deviceMemoryGb?: number, smt = true): number {
  const s = config.scheduler;
  const cores = Number.isFinite(hardwareConcurrency) && hardwareConcurrency > 0 ? hardwareConcurrency : 1;
  let n = Math.min(Math.round(cores * s.workerShare), s.maxWorkers);
  // Leave the machine room to breathe. Browsers report logical cores, and on a hyper-threaded CPU
  // two of them share one physical core, so the pool is sized against an estimate of physical
  // cores: those, less the app's own busy threads (coordinator, physics) and `reserveCores` kept
  // free for the UI thread and everything else on the computer. An 8-core / 16-thread CPU gets
  // 8 − 2 − 1 = 5 workers, not 8 workers on top of the others, which saturated every core.
  const physical = Math.max(1, Math.floor(cores / (smt ? Math.max(1, s.threadsPerCore) : 1)));
  n = Math.min(n, physical - s.busyAppThreads - s.reserveCores);
  n = Math.min(n, Math.floor(s.memoryCapMB / s.memoryPerWorkerMB));
  if (deviceMemoryGb !== undefined && Number.isFinite(deviceMemoryGb) && deviceMemoryGb > 0) {
    // The pool may use the same share of the device's memory as it uses of its cores, until the
    // config has a value of its own for this (scheduler.deviceMemoryShare).
    const share = (s as { deviceMemoryShare?: number }).deviceMemoryShare ?? s.workerShare;
    n = Math.min(n, Math.floor((deviceMemoryGb * 1024 * share) / s.memoryPerWorkerMB));
  }
  return Math.max(1, n);
}
