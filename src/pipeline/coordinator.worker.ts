// Coordinator worker (PLAN.md §3): owns the canonical ModelStore and the compute pool, runs the
// pipeline, and streams patch batches and events to the main thread. Lead-owned.
import { createWorkerPool } from '../compute';
import type { ComputePool } from '../contracts/compute';
import type { PipelineEvents } from '../contracts/pipeline';
import type { ModelStore } from '../contracts/store';
import { openRepoAccess } from '../git';
import { createModelStore, decodeModel } from '../model';
import type { LayoutSnapshot } from '../model/types';
import { runSource, type PipelineDeps, type PipelineState } from './core';
import type { CoordinatorCalls, FromCoordinator, MainCalls, MainMethod, ToCoordinator } from './protocol';

const scope = self as unknown as DedicatedWorkerGlobalScope;
const post = (m: FromCoordinator, transfer: Transferable[] = []) => scope.postMessage(m, transfer);

let store: ModelStore | null = null;
let pool: ComputePool | null = null;
let state: PipelineState | null = null;
let deps: PipelineDeps | null = null;

// ---- requests to the main thread ----
let nextId = 1;
const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
function askMain<M extends MainMethod>(method: M, ...args: Parameters<MainCalls[M]>): Promise<ReturnType<MainCalls[M]>> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    post({ type: 'request', id, method, args });
  });
}

function emit<E extends keyof PipelineEvents>(evt: E, payload: PipelineEvents[E]): void {
  post({ type: 'event', evt, payload } as FromCoordinator);
}

// ---- interaction comes first: park background work while frames run long (PLAN.md §3.1) ----
let parkLevel: 0 | 1 | 2 = 0;
let slowFrames = 0, fastFrames = 0;
function onFrame(frameMs: number, interacting: boolean, limit: number): void {
  if (!pool) return;
  if (interacting && frameMs > limit) { slowFrames++; fastFrames = 0; } else { fastFrames++; slowFrames = 0; }
  let next = parkLevel;
  if (slowFrames >= 2 && parkLevel < 2) { next = (parkLevel + 1) as 1 | 2; slowFrames = 0; }
  else if (fastFrames >= 4 && parkLevel > 0) { next = (parkLevel - 1) as 0 | 1; fastFrames = 0; }
  if (next !== parkLevel) { parkLevel = next; pool.setParkLevel(parkLevel); }
}

const calls: { [M in keyof CoordinatorCalls]: (...args: Parameters<CoordinatorCalls[M]>) => Promise<ReturnType<CoordinatorCalls[M]>> | ReturnType<CoordinatorCalls[M]> } = {
  exportModel(layout: LayoutSnapshot) {
    if (!store) throw new Error('no model yet');
    return store.toModel(layout);
  },
  async applyRefined() {
    const hooks = await import('./post');
    if (!deps || !state) throw new Error('nothing to apply');
    await hooks.applyRefined(deps, state);
  },
  async update() {
    const hooks = await import('./post');
    if (!deps || !state) throw new Error('nothing to update');
    await hooks.update(deps, state);
  },
};

scope.onmessage = (ev: MessageEvent<ToCoordinator>) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'start': {
      const config = msg.config;
      store = createModelStore();
      store.subscribe((batch) => emit('batch', batch));
      pool = createWorkerPool({ config });
      deps = {
        config, pool, store, emit,
        physics: {
          settle: (maxMs) => askMain('settle', maxMs),
          loadLayout: (layout) => askMain('loadLayout', layout),
          getLayout: () => askMain('getLayout'),
        },
        openRepo: openRepoAccess,
        async loadDemo(baseUrl) {
          const res = await fetch(new URL('snapshot.gitmap.json.gz', new URL(baseUrl, scope.location.href)));
          if (!res.ok) throw new Error(`Could not load the demo (${res.status}).`);
          return decodeModel(new Uint8Array(await res.arrayBuffer()));
        },
      };
      post({ type: 'started' });
      runSource(msg.source, deps).then(
        async (s) => {
          state = s;
          const hooks = await import('./post');
          hooks.afterReveal(deps!, s).catch((err) => emit('error', { message: String(err?.message ?? err), fatal: false }));
        },
        (err) => post({ type: 'failed', message: String(err?.message ?? err) }),
      );
      break;
    }
    case 'reply': {
      const p = pending.get(msg.id);
      if (!p) break;
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.value); else p.reject(new Error(msg.error));
      break;
    }
    case 'call': {
      Promise.resolve()
        .then(() => (calls[msg.method] as (...a: unknown[]) => unknown)(...msg.args))
        .then(
          (value) => post({ type: 'result', id: msg.id, ok: true, value }),
          (err) => post({ type: 'result', id: msg.id, ok: false, error: String(err?.message ?? err) }),
        );
      break;
    }
    case 'selectedOverlay':
      // history feeds Recency, Ownership and Knowledge risk alike (PLAN.md §3.1)
      pool?.setGroupLane('history', msg.layer && ['recency', 'ownership', 'knowledgeRisk'].includes(msg.layer) ? 'selectedOverlay' : 'otherOverlays');
      break;
    case 'frame':
      if (deps) onFrame(msg.frameMs, msg.interacting, deps.config.scheduler.parkWhenFrameMsOver);
      break;
  }
};
