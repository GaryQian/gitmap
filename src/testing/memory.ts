// In-memory stand-ins for disk access and the pool, so packages can be tested alone.
import type { Config } from '../config';
import type { ComputePool, Lane, PoolStats, TaskContext, TaskDef, TaskRequest } from '../contracts/compute';
import { LANES } from '../contracts/compute';
import type { ContentSource, DirEntry, GitFs, RepoAccess, RepoLocator, WorkingTree } from '../contracts/git';
import { parseRef, type NodeRef } from '../model/types';

/** A WorkingTree over path → bytes. */
export class MemoryWorkingTree implements WorkingTree {
  constructor(readonly files: Record<string, Uint8Array | string>, private mtimeMs = 0) {}
  private bytes(path: string): Uint8Array | null {
    const v = this.files[path];
    return v === undefined ? null : typeof v === 'string' ? new TextEncoder().encode(v) : v;
  }
  async read(path: string): Promise<Uint8Array | null> { return this.bytes(path); }
  async stat(path: string): Promise<{ size: number; mtimeMs: number } | null> {
    const b = this.bytes(path);
    return b ? { size: b.length, mtimeMs: this.mtimeMs } : null;
  }
  async list(dir: string): Promise<DirEntry[]> {
    const prefix = dir === '' ? '' : dir.replace(/\/$/, '') + '/';
    const seen = new Map<string, 'file' | 'dir'>();
    for (const p of Object.keys(this.files)) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) seen.set(rest, 'file'); else seen.set(rest.slice(0, slash), 'dir');
    }
    return [...seen].map(([name, kind]) => ({ name, kind })).sort((a, b) => (a.name < b.name ? -1 : 1));
  }
}

/** A GitFs over path-relative-to-.git → bytes. */
export class MemoryGitFs implements GitFs {
  constructor(readonly files: Record<string, Uint8Array>) {}
  readAt(path: string, offset: number, length: number): Uint8Array {
    const b = this.files[path];
    if (!b) throw new Error(`MemoryGitFs: no such file ${path}`);
    return b.subarray(offset, offset + length);
  }
  size(path: string): number { return this.files[path]?.length ?? -1; }
  list(dir: string): string[] {
    const prefix = dir === '' ? '' : dir.replace(/\/$/, '') + '/';
    const names = new Set<string>();
    for (const p of Object.keys(this.files)) if (p.startsWith(prefix)) names.add(p.slice(prefix.length).split('/')[0]);
    return [...names].sort();
  }
}

/** A plain-folder RepoAccess (no .git) over path → text or bytes. */
export function memoryRepo(name: string, files: Record<string, Uint8Array | string>): RepoAccess {
  return { name, tree: new MemoryWorkingTree(files), git: null };
}

/** A ContentSource over path → text or bytes. */
export class MemoryContentSource implements ContentSource {
  constructor(private files: Record<string, Uint8Array | string>) {}
  async read(ref: NodeRef): Promise<Uint8Array> {
    const v = this.files[parseRef(ref).id];
    if (v === undefined) throw new Error(`no content for ${ref}`);
    return typeof v === 'string' ? new TextEncoder().encode(v) : v;
  }
}

/**
 * A minimal ComputePool that runs tasks in process, one at a time, in lane-priority order.
 * It has no workers, parking or floors: use the real pools from src/compute to test scheduling.
 */
export function createFakePool(opts: { config: Config; tasks: TaskDef[]; repo?: RepoAccess | null; openRepo?: (l: RepoLocator) => Promise<RepoAccess> }): ComputePool {
  const defs = new Map(opts.tasks.map((t) => [t.type, t]));
  let repo: RepoAccess | null = opts.repo ?? null;
  const cache = new Map<string, unknown>();
  const ctx: TaskContext = { config: opts.config, repo: async () => repo, cache, transfer() {} };
  type Job = { req: TaskRequest; resolve(v: unknown): void; reject(e: unknown): void };
  const queues = new Map<Lane, Job[]>(LANES.map((l) => [l, []]));
  const groupLane = new Map<string, Lane>();
  let running = false, completed = 0, disposed = false;
  const laneOf = (req: TaskRequest): Lane => (req.group && groupLane.get(req.group)) || req.lane;
  async function pump(): Promise<void> {
    if (running) return;
    running = true;
    try {
      for (;;) {
        let job: Job | undefined;
        for (const lane of LANES) { job = queues.get(lane)!.shift(); if (job) break; }
        if (!job) break;
        const def = defs.get(job.req.type);
        try {
          if (!def) throw new Error(`unknown task type: ${job.req.type}`);
          job.resolve(await def.run(job.req.input, ctx));
        } catch (e) { job.reject(e); }
        completed++;
      }
    } finally { running = false; }
  }
  return {
    size: 1,
    run<O, I>(req: TaskRequest<I>): Promise<O> {
      if (disposed) return Promise.reject(new Error('pool disposed'));
      return new Promise<O>((resolve, reject) => {
        queues.get(laneOf(req))!.push({ req, resolve: resolve as (v: unknown) => void, reject });
        queueMicrotask(pump);
      });
    },
    async setRepo(locator) { repo = locator && opts.openRepo ? await opts.openRepo(locator) : locator ? repo : null; },
    setGroupLane(group, lane) {
      groupLane.set(group, lane);
      for (const [l, q] of queues) {
        if (l === lane) continue;
        const moved = q.filter((j) => j.req.group === group);
        if (moved.length) { queues.set(l, q.filter((j) => j.req.group !== group)); queues.get(lane)!.push(...moved); }
      }
    },
    setParkLevel() {},
    cancel(group) {
      for (const [l, q] of queues) {
        const drop = q.filter((j) => group === undefined || j.req.group === group);
        queues.set(l, q.filter((j) => !drop.includes(j)));
        for (const j of drop) j.reject(new Error('cancelled'));
      }
    },
    stats(): PoolStats {
      const queued = Object.fromEntries(LANES.map((l) => [l, queues.get(l)!.length])) as Record<Lane, number>;
      return { workers: 1, busy: running ? 1 : 0, parked: 0, queued, completed };
    },
    dispose() { disposed = true; this.cancel(); },
  };
}
