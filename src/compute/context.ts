// The TaskContext a worker (real or simulated) hands to its tasks, and the repo it lazily opens.
import type { Config } from '../config';
import type { TaskContext } from '../contracts/compute';
import type { RepoAccess, RepoLocator } from '../contracts/git';

export interface WorkerState {
  readonly ctx: TaskContext;
  setConfig(config: Config): void;
  /** Point the worker at another repo (or none). It is opened on the first ctx.repo() call. */
  setRepo(locator: RepoLocator | null): void;
}

export function createWorkerState(
  initialConfig: Config,
  openRepo: (locator: RepoLocator) => Promise<RepoAccess>,
  onTransfer: (buffers: Transferable[]) => void,
): WorkerState {
  let config = initialConfig;
  let locator: RepoLocator | null = null;
  let opened: Promise<RepoAccess> | null = null;
  const ctx: TaskContext = {
    get config() { return config; },
    cache: new Map<string, unknown>(),
    repo(): Promise<RepoAccess | null> {
      if (!locator) return Promise.resolve(null);
      if (!opened) {
        const p = openRepo(locator);
        opened = p;
        // A failed open is not cached: the next task tries again.
        p.catch(() => { if (opened === p) opened = null; });
      }
      return opened;
    },
    transfer(...buffers: Transferable[]): void { onTransfer(buffers); },
  };
  return {
    ctx,
    setConfig(c) { config = c; },
    setRepo(l) { locator = l; opened = null; },
  };
}
