// Public surface of src/physics. Package 1F owns this folder.
//
//   engine.ts      the in-process engine: scheduler slice, drag, reset, layout save/load
//   world.ts       engine state, buffer rows, radii carried upward
//   topology.ts    patch batches → nodes and links of the affected simulations
//   placement.ts   where a new node starts
//   settle.ts      the pre-reveal settle
//   cityTier.ts · districtTier.ts · fileTier.ts   one file per tier: its forces and sizes
//   forces.ts      forceContain, forceExternalPull, forceGridCollide
//   worker.ts · client.ts · protocol.ts           the engine in a dedicated worker
import type { PhysicsApi, PhysicsEngine, PhysicsInit } from '../contracts/physics';
import { createClient } from './client';
import { createEngine } from './engine';

/** The engine, in process: used by the Node pipeline, by tests, and inside the physics worker. */
export function createPhysicsEngine(init: PhysicsInit): PhysicsEngine {
  return createEngine(init);
}

/**
 * The engine in a dedicated worker (src/physics/worker.ts), driven by its own time-sliced scheduler.
 * Uses SharedArrayBuffers when the page is cross-origin isolated, otherwise posts position chunks at 30 Hz.
 */
export function createPhysicsClient(init: PhysicsInit): PhysicsApi {
  return createClient(init, new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }));
}
