// The in-process backend: simulated workers that run TaskDefs on the calling thread.
import type { Config } from '../config';
import type { TaskDef } from '../contracts/compute';
import type { RepoAccess, RepoLocator } from '../contracts/git';
import { createWorkerState } from './context';
import type { PoolBackend } from './pool';
import { runTask, taskTable } from './tasks';

export interface InlineBackendOptions {
  config: Config;
  tasks: TaskDef[];
  openRepo?: (locator: RepoLocator) => Promise<RepoAccess>;
  size?: number;
}

/** Let timers, I/O and message callbacks run before the next task starts. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof setImmediate === 'function') setImmediate(resolve); else setTimeout(resolve, 0);
  });
}

export function createInlineBackend(opts: InlineBackendOptions): PoolBackend {
  const table = taskTable(opts.tasks);
  const size = Math.max(1, Math.floor(opts.size ?? 1));
  const open = opts.openRepo ?? (() => Promise.reject(new Error('createInlinePool: no openRepo was given')));
  const workers = Array.from({ length: size }, () => createWorkerState(opts.config, open, () => {}));
  return {
    size,
    onWorkerLost: null,
    run: (worker, req) => yieldToEventLoop().then(() => runTask(table, req.type, req.input, workers[worker].ctx)),
    async setRepo(locator) {
      if (locator && !opts.openRepo) throw new Error('createInlinePool: setRepo needs the openRepo option');
      for (const w of workers) w.setRepo(locator);
    },
    dispose() {},
  };
}
