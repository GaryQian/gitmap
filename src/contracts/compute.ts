// The shared compute pool and its priority lanes (PLAN.md §3.1). Implemented by src/compute.
import type { Config } from '../config';
import type { RepoAccess, RepoLocator } from './git';

/** Lanes in priority order: a free worker takes from the first lane that has a task. */
export const LANES = ['interactive', 'selectedOverlay', 'parse', 'otherOverlays', 'housekeeping'] as const;
export type Lane = (typeof LANES)[number];

export interface TaskRequest<I = unknown> {
  /** Name of a registered task (see TaskDef). */
  type: string;
  lane: Lane;
  input: I;
  /** Buffers in `input` to transfer instead of copy. */
  transfer?: Transferable[];
  /**
   * Tasks sharing a group can be moved between lanes together (for example group 'history' is moved
   * to 'selectedOverlay' while a history overlay is selected).
   */
  group?: string;
}

/** What a task sees while it runs. One context per worker. */
export interface TaskContext {
  readonly config: Config;
  /** The repo broadcast to the pool, opened lazily and cached for the worker's lifetime. Null if none was set. */
  repo(): Promise<RepoAccess | null>;
  /** Per-worker scratch space that survives between tasks (parser instances, caches, retained bytes). */
  readonly cache: Map<string, unknown>;
  /** Buffers handed back to the caller are listed here to transfer them instead of copying. */
  transfer(...buffers: Transferable[]): void;
}

/**
 * A unit of work that runs on a pool worker. Each task lives in its own `*.task.ts` file that
 * default-exports a TaskDef; worker entry points discover them with import.meta.glob, so adding a
 * task never touches a shared file. Keep tasks small (target config.scheduler.taskTargetMs).
 */
export interface TaskDef<I = any, O = any> {
  type: string;
  run(input: I, ctx: TaskContext): O | Promise<O>;
}
export function defineTask<I, O>(def: TaskDef<I, O>): TaskDef<I, O> { return def; }

export interface PoolStats {
  workers: number;
  busy: number;
  parked: number;
  queued: Record<Lane, number>;
  completed: number;
}

export interface ComputePool {
  /** Number of workers. */
  readonly size: number;
  /** Queue a task. Rejects if the task throws or the pool is disposed. */
  run<O = unknown, I = unknown>(req: TaskRequest<I>): Promise<O>;
  /** Tell every worker which repo to open. Resolves when all have acknowledged. */
  setRepo(locator: RepoLocator | null): Promise<void>;
  /** Move every queued and future task of a group to another lane. */
  setGroupLane(group: string, lane: Lane): void;
  /**
   * Interaction comes first: 0 = run everything, 1 = park workers serving lanes parse and below,
   * 2 = also park the selected-overlay lane. Running tasks finish; the interactive lane always runs.
   */
  setParkLevel(level: 0 | 1 | 2): void;
  /** Reject and drop queued tasks, optionally only one group's. Running tasks finish and are ignored. */
  cancel(group?: string): void;
  stats(): PoolStats;
  dispose(): void;
}
