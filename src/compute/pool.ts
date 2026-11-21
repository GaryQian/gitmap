// A ComputePool over any set of workers: the scheduler core decides, a backend executes.
import type { Config } from '../config';
import type { ComputePool, TaskRequest } from '../contracts/compute';
import type { RepoLocator } from '../contracts/git';
import { Scheduler } from './scheduler';

/** What actually runs tasks: Web Workers (workerPool.ts) or in-process contexts (inline.ts). */
export interface PoolBackend {
  readonly size: number;
  /** Run one task on worker `worker`, which is free. Settles with the task's result or its error. */
  run(worker: number, req: TaskRequest): Promise<unknown>;
  setRepo(locator: RepoLocator | null): Promise<void>;
  dispose(): void;
  /** Set by the pool. The backend calls it when a worker is gone for good and was not replaced. */
  onWorkerLost: ((worker: number, error: Error) => void) | null;
}

interface Job { req: TaskRequest; resolve(value: unknown): void; reject(error: unknown): void }

export function createPool(config: Config, backend: PoolBackend): ComputePool {
  const sched = new Scheduler<Job>({ workers: backend.size, parseFloorWorkers: config.scheduler.parseFloorWorkers });
  let disposed = false;
  /** Set when no worker is left: every task fails with it. */
  let fatal: Error | null = null;
  let pumpQueued = false;

  function pump(): void {
    pumpQueued = false;
    if (disposed) return;
    for (let a = sched.take(); a; a = sched.take()) start(a.worker, a.task.payload);
  }
  // Dispatch once per microtask turn, so tasks queued together compete by lane, not by call order.
  function schedulePump(): void {
    if (pumpQueued || disposed) return;
    pumpQueued = true;
    queueMicrotask(pump);
  }
  function start(worker: number, job: Job): void {
    let running: Promise<unknown>;
    try { running = backend.run(worker, job.req); } catch (e) { running = Promise.reject(e); }
    const done = (): void => {
      if (disposed) return;
      sched.finish(worker);
      schedulePump();
    };
    // If the task was cancelled its promise is already rejected, so settling it again drops the result.
    running.then((value) => { done(); job.resolve(value); }, (error) => { done(); job.reject(error); });
  }

  backend.onWorkerLost = (worker, error) => {
    if (disposed) return;
    sched.retire(worker);
    if (sched.stats().workers > 0) return;
    fatal = error;
    for (const t of sched.cancel()) t.payload.reject(error);
  };

  return {
    size: backend.size,
    run<O, I>(req: TaskRequest<I>): Promise<O> {
      if (disposed) return Promise.reject(new Error('pool disposed'));
      if (fatal) return Promise.reject(fatal);
      return new Promise<O>((resolve, reject) => {
        sched.enqueue({ req, resolve: resolve as (value: unknown) => void, reject }, req.lane, req.group);
        schedulePump();
      });
    },
    setRepo(locator) {
      if (disposed) return Promise.reject(new Error('pool disposed'));
      return backend.setRepo(locator);
    },
    setGroupLane(group, lane) { sched.setGroupLane(group, lane); schedulePump(); },
    setParkLevel(level) { sched.setParkLevel(level); schedulePump(); },
    cancel(group) {
      const error = new Error('cancelled');
      for (const t of sched.cancel(group)) t.payload.reject(error);
    },
    stats: () => sched.stats(),
    dispose() {
      if (disposed) return;
      disposed = true;
      const error = new Error('pool disposed');
      for (const t of sched.cancel()) t.payload.reject(error);
      backend.dispose();
    },
  };
}
