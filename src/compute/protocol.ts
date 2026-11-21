// Messages between the pool (pool side: workerPool.ts) and a pool worker (worker.ts).
//
//   pool → worker   init    { config }                 once, first; the pool's config (may carry overrides)
//                   setRepo { seq, locator | null }    answered by repoSet { seq }; the repo opens lazily
//                   run     { id, task, input }        one at a time per worker; input buffers may be transferred
//   worker → pool   ready   {}                         the worker module loaded (tasks are discovered)
//                   repoSet { seq }
//                   result  { id, ok: true, value }    buffers passed to ctx.transfer() are transferred
//                           { id, ok: false, error }   the task threw, its type is unknown, or its value cannot be cloned
import type { Config } from '../config';
import type { RepoLocator } from '../contracts/git';

export type ToWorker =
  | { type: 'init'; config: Config }
  | { type: 'setRepo'; seq: number; locator: RepoLocator | null }
  | { type: 'run'; id: number; task: string; input: unknown };

export interface WireError { name: string; message: string; stack?: string }

export type FromWorker =
  | { type: 'ready' }
  | { type: 'repoSet'; seq: number }
  | { type: 'result'; id: number; ok: true; value: unknown }
  | { type: 'result'; id: number; ok: false; error: WireError };

export function toWireError(e: unknown): WireError {
  if (e instanceof Error) return { name: e.name, message: e.message, stack: e.stack };
  return { name: 'Error', message: typeof e === 'string' ? e : String(e) };
}

export function fromWireError(w: WireError): Error {
  const e = new Error(w.message);
  e.name = w.name;
  if (w.stack) e.stack = w.stack;
  return e;
}
