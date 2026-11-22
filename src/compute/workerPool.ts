// The Web Worker backend. It uses nothing that exists only on the main thread, so the pool can be
// created inside the coordinator worker (nested workers).
import type { Config } from '../config';
import type { RepoLocator } from '../contracts/git';
import type { PoolBackend } from './pool';
import { fromWireError, type FromWorker, type ToWorker } from './protocol';

/**
 * A worker that fails this many times in a row without ever answering is not replaced again (its
 * script cannot load, so a new one would fail the same way). The slot is retired instead.
 */
const MAX_FAILED_STARTS = 3;
/** A task whose worker died is given to the replacement worker this many times before it fails. */
const MAX_TASK_RETRIES = 2;

interface Slot {
  worker: Worker | null;
  running: { id: number; resolve(value: unknown): void; reject(error: Error): void; task: string; input: unknown; canResend: boolean; retries: number } | null;
  /** setRepo calls waiting for this worker's acknowledgement, by seq. */
  acks: Map<number, () => void>;
  failedStarts: number;
  retired: boolean;
}

export function createWorkerBackend(config: Config, size: number): PoolBackend {
  let locator: RepoLocator | null = null;
  let disposed = false;
  let nextId = 1;
  const slots: Slot[] = Array.from({ length: size }, () => ({ worker: null, running: null, acks: new Map(), failedStarts: 0, retired: false }));

  function send(slot: Slot, msg: ToWorker, transfer: Transferable[] = []): void {
    slot.worker!.postMessage(msg, transfer);
  }

  function spawn(i: number): void {
    const slot = slots[i];
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    slot.worker = worker;
    worker.onmessage = (ev: MessageEvent<FromWorker>) => { if (slot.worker === worker) onMessage(slot, ev.data); };
    worker.onerror = (ev) => {
      ev.preventDefault?.();
      // No message at all means the script (or one of its imports) could not be loaded.
      const why = ev.message || (import.meta.env?.DEV
        ? 'its script could not be loaded (if the dev server restarted or rebuilt, reload the page)'
        : 'its script could not be loaded');
      if (slot.worker === worker) onFailure(i, new Error(`compute worker ${i} failed: ${why}`));
    };
    worker.onmessageerror = () => {
      if (slot.worker === worker) onFailure(i, new Error(`compute worker ${i} sent a message that could not be read`));
    };
    send(slot, { type: 'init', config });
    if (locator) send(slot, { type: 'setRepo', seq: 0, locator });
  }

  function onMessage(slot: Slot, msg: FromWorker): void {
    slot.failedStarts = 0;
    if (msg.type === 'repoSet') {
      slot.acks.get(msg.seq)?.();
      slot.acks.delete(msg.seq);
    } else if (msg.type === 'result') {
      const running = slot.running;
      if (!running || running.id !== msg.id) return;
      slot.running = null;
      if (msg.ok) running.resolve(msg.value); else running.reject(fromWireError(msg.error));
    }
  }

  /** The worker threw outside a task or died: fail its task and replace it. */
  function onFailure(i: number, error: Error): void {
    const slot = slots[i];
    console.error(`[compute] ${error.message}`);
    slot.worker?.terminate();
    slot.worker = null;
    const running = slot.running;
    slot.running = null;
    if (++slot.failedStarts >= MAX_FAILED_STARTS) slot.retired = true;
    else {
      try { spawn(i); } catch { slot.retired = true; }
    }
    // The replacement was sent the current locator before anything else, which is what the callers
    // waiting on an acknowledgement need; a retired worker has nothing left to acknowledge.
    for (const ack of slot.acks.values()) ack();
    slot.acks.clear();
    // One lost worker should not fail a parse: hand its task to the replacement, unless the input's
    // buffers were transferred away with the first attempt.
    if (running && slot.worker && running.canResend && running.retries < MAX_TASK_RETRIES) {
      const id = nextId++;
      slot.running = { ...running, id, retries: running.retries + 1 };
      try {
        send(slot, { type: 'run', id, task: running.task, input: running.input });
      } catch (e) {
        slot.running = null;
        running.reject(e as Error);
      }
    } else running?.reject(error);
    if (slot.retired) backend.onWorkerLost?.(i, error);
  }

  const backend: PoolBackend = {
    size,
    onWorkerLost: null,
    run(i, req) {
      const slot = slots[i];
      return new Promise<unknown>((resolve, reject) => {
        if (!slot.worker) { reject(new Error(`compute worker ${i} is not running`)); return; }
        const id = nextId++;
        slot.running = { id, resolve, reject, task: req.type, input: req.input, canResend: !req.transfer?.length, retries: 0 };
        try {
          send(slot, { type: 'run', id, task: req.type, input: req.input }, req.transfer ?? []);
        } catch (e) {
          // The input could not be cloned: the task fails, the worker is fine.
          slot.running = null;
          reject(e);
        }
      });
    },
    async setRepo(next) {
      if (disposed) throw new Error('pool disposed');
      locator = next;
      await Promise.all(slots.map((slot) => new Promise<void>((resolve, reject) => {
        if (!slot.worker) { resolve(); return; }
        const seq = nextId++;
        slot.acks.set(seq, resolve);
        try {
          send(slot, { type: 'setRepo', seq, locator: next });
        } catch (e) {
          slot.acks.delete(seq);
          reject(e);
        }
      })));
    },
    dispose() {
      disposed = true;
      for (const slot of slots) {
        slot.worker?.terminate();
        slot.worker = null;
        slot.running = null;
        for (const ack of slot.acks.values()) ack();
        slot.acks.clear();
      }
    },
  };

  for (let i = 0; i < size; i++) spawn(i);
  return backend;
}
