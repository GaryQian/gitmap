// Public surface of src/physics. Package 1F owns this folder.
//
//   engine.ts      the in-process engine: scheduler slice, drag, reset, layout save/load
//   world.ts       engine state, buffer rows, keeping a city's cells current
//   topology.ts    patch batches → nodes and links of the affected simulations
//   placement.ts   where a new node starts
//   settle.ts      the pre-reveal settle
//   space.ts       radii carried upward, eased; updates kept local with pins
//   cells.ts       district territories: the cells that tile a city
//   cityTier.ts · districtTier.ts · fileTier.ts   one file per tier: its forces and sizes
//   forces.ts      the custom forces: collide, containment, size → place, Lloyd, outside pull
//   quality.ts     overlap and evenness of fill, for reports
//   worker.ts · client.ts · protocol.ts           the engine in a dedicated worker
import type { PhysicsInit } from '../contracts/physics';
import { createClient, type PhysicsClient } from './client';
import { createEngine, type PhysicsEngineInternal } from './engine';

export type { PhysicsClient } from './client';
export type { PhysicsEngineInternal } from './engine';

/** The engine, in process: used by the Node pipeline, by tests, and inside the physics worker. */
export function createPhysicsEngine(init: PhysicsInit): PhysicsEngineInternal {
  return createEngine(init);
}

/**
 * The engine in a dedicated worker (src/physics/worker.ts), driven by its own time-sliced scheduler.
 * Uses SharedArrayBuffers when the page is cross-origin isolated, otherwise posts position chunks at 30 Hz.
 */
export function createPhysicsClient(init: PhysicsInit): PhysicsClient {
  return createClient(init, new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }));
}
