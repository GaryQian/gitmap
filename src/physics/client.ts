// The page's handle on the physics worker (PhysicsApi). Commands are forwarded as messages.
// Positions are views over SharedArrayBuffers the worker writes into when the page is cross-origin
// isolated; otherwise the worker posts changed rows at about 30 Hz and they are copied in here.
import {
  GEN_ANY, GEN_CITY, GEN_DISTRICT0, GEN_HOT, GEN_REV,
  type PhysicsApi, type PhysicsInit, type PositionBuffers, type SettleReport,
} from '../contracts/physics';
import type { LayoutSnapshot } from '../model/types';
import { allocateBuffers, canShare, growBuffers } from './buffers';
import type { FromWorker, ToWorker } from './protocol';

export interface ClientOptions {
  /** Post rows instead of sharing memory even when sharing is possible (to exercise the fallback). */
  forceCopy?: boolean;
}

interface Waiter { resolve: (value: any) => void; reject: (err: Error) => void }

export function createClient(init: PhysicsInit, worker: Worker, opts: ClientOptions = {}): PhysicsApi {
  const shared = canShare() && !opts.forceCopy;
  const cap = { units: Math.max(1, init.capacity.units), districts: Math.max(1, init.capacity.districts), cities: Math.max(1, init.capacity.cities) };
  let positions = allocateBuffers(cap, shared);
  const listeners = new Set<(b: PositionBuffers) => void>();
  const waiting = new Map<number, Waiter>();
  let nextId = 1;
  let rev = 0;
  let atHome = true;
  let disposed = false;

  const send = (m: ToWorker) => { if (!disposed) worker.postMessage(m); };
  const request = <T>(make: (id: number) => ToWorker): Promise<T> => new Promise<T>((resolve, reject) => {
    if (disposed) { reject(new Error('physics client: disposed')); return; }
    const id = nextId++;
    waiting.set(id, { resolve, reject });
    send(make(id));
  });
  const settleWaiter = (id: number, value: unknown) => {
    const waiter = waiting.get(id);
    waiting.delete(id);
    waiter?.resolve(value);
  };
  const setBuffers = (next: PositionBuffers) => {
    positions = next;
    for (const fn of [...listeners]) fn(positions);
  };

  worker.onmessage = (ev: MessageEvent<FromWorker>) => {
    const m = ev.data;
    switch (m.type) {
      case 'buffers': setBuffers(m.buffers); break;
      case 'capacity': setBuffers(growBuffers(positions, m.capacity)); break;
      case 'positions': {
        const { unit, district, city, gen } = positions;
        if (m.city) { city.set(m.city.subarray(0, city.length)); gen[GEN_CITY]++; }
        for (let i = 0; i < m.districtSlots.length; i++) {
          const d = m.districtSlots[i];
          district[3 * d] = m.districtRows[3 * i];
          district[3 * d + 1] = m.districtRows[3 * i + 1];
          district[3 * d + 2] = m.districtRows[3 * i + 2];
          gen[GEN_DISTRICT0 + d]++;
        }
        for (let i = 0; i < m.unitSlots.length; i++) {
          const s = m.unitSlots[i];
          unit[2 * s] = m.unitXZ[2 * i];
          unit[2 * s + 1] = m.unitXZ[2 * i + 1];
        }
        gen[GEN_ANY]++;
        gen[GEN_HOT] = m.hot;
        gen[GEN_REV] = m.rev; // last: these rows are what that revision looks like
        break;
      }
      case 'state': atHome = m.atHome; break;
      case 'settled': settleWaiter(m.id, m.report); break;
      case 'resetDone': settleWaiter(m.id, undefined); break;
      case 'layout': settleWaiter(m.id, m.layout); break;
      case 'error': {
        const waiter = m.id === undefined ? undefined : waiting.get(m.id);
        if (m.id !== undefined) waiting.delete(m.id);
        if (waiter) waiter.reject(new Error(m.message));
        else console.error('[physics worker]', m.message);
        break;
      }
    }
  };
  worker.onerror = (ev) => { console.error('[physics worker]', ev.message); };

  send({ type: 'init', config: init.config, capacity: cap, seed: init.seed, buffers: shared ? positions : null });

  return {
    get positions() { return positions; },
    onBuffers(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    applyBatch(batch) {
      // same rule as the engine, checked here so the caller hears about a gap synchronously
      if (!batch.full && batch.baseRev !== rev) {
        throw new Error(`physics: revision gap (at ${rev}, batch is based on ${batch.baseRev}); resync with a full batch`);
      }
      rev = batch.rev;
      send({ type: 'batch', batch });
    },
    settle: (maxMs) => request<SettleReport>((id) => ({ type: 'settle', id, maxMs })),
    drag(ref, x, z) {
      if (ref[0] === 'c' || ref[0] === 'd') atHome = false; // the worker confirms; do not wait a frame to say so
      send({ type: 'drag', ref, x, z });
    },
    release(ref) { send({ type: 'release', ref }); },
    resetLayout: () => request<void>((id) => ({ type: 'reset', id })),
    isAtHome: () => atHome,
    setFocus(target, radius) { send({ type: 'focus', x: target.x, z: target.z, radius }); },
    getLayout: () => request<LayoutSnapshot>((id) => ({ type: 'getLayout', id })),
    loadLayout(layout) { send({ type: 'loadLayout', layout }); },
    dispose() {
      if (disposed) return;
      send({ type: 'dispose' });
      disposed = true;
      worker.terminate();
      listeners.clear();
      for (const waiter of waiting.values()) waiter.reject(new Error('physics client: disposed'));
      waiting.clear();
    },
  };
}
