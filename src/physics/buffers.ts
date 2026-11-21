// PositionBuffers allocation and growth (contracts/physics.ts). Views over SharedArrayBuffers when
// they can be shared with the page, plain ArrayBuffers otherwise.
import { GEN_DISTRICT0, type PhysicsCapacity, type PositionBuffers } from '../contracts/physics';

/** SharedArrayBuffer is usable: always in Node, and in a browser only when cross-origin isolated. */
export function canShare(): boolean {
  return typeof SharedArrayBuffer !== 'undefined' && (typeof crossOriginIsolated === 'undefined' || crossOriginIsolated);
}

export function allocateBuffers(cap: PhysicsCapacity, shared: boolean = canShare()): PositionBuffers {
  const buf = (bytes: number) => (shared ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes));
  return {
    shared,
    unit: new Float32Array(buf(cap.units * 2 * 4)),
    district: new Float32Array(buf(cap.districts * 3 * 4)),
    city: new Float32Array(buf(cap.cities * 3 * 4)),
    gen: new Int32Array(buf((GEN_DISTRICT0 + cap.districts) * 4)),
  };
}

export function capacityOf(b: PositionBuffers): PhysicsCapacity {
  return { units: b.unit.length / 2, districts: b.district.length / 3, cities: b.city.length / 3 };
}

/** Bigger buffers holding everything the old ones held, counters included. */
export function growBuffers(old: PositionBuffers, cap: PhysicsCapacity): PositionBuffers {
  const next = allocateBuffers(cap, old.shared);
  next.unit.set(old.unit);
  next.district.set(old.district);
  next.city.set(old.city);
  next.gen.set(old.gen);
  return next;
}

/** Capacity that fits `need`, growing by half again so repeated small batches do not reallocate each time. */
export function fitCapacity(cap: PhysicsCapacity, need: PhysicsCapacity): PhysicsCapacity | null {
  if (need.units <= cap.units && need.districts <= cap.districts && need.cities <= cap.cities) return null;
  const fit = (have: number, want: number) => (want <= have ? have : Math.max(want, Math.ceil(have * 1.5)));
  return { units: fit(cap.units, need.units), districts: fit(cap.districts, need.districts), cities: fit(cap.cities, need.cities) };
}
