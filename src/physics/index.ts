// Public surface of src/physics. Package 1F owns this folder.
import type { PhysicsApi, PhysicsEngine, PhysicsInit } from '../contracts/physics';

/** The engine, in process: used by the Node pipeline, by tests, and inside the physics worker. */
export function createPhysicsEngine(_init: PhysicsInit): PhysicsEngine {
  throw new Error('not implemented: createPhysicsEngine (package 1F)');
}

/**
 * The engine in a dedicated worker (src/physics/worker.ts), driven by its own time-sliced scheduler.
 * Uses SharedArrayBuffers when the page is cross-origin isolated, otherwise posts position chunks at 30 Hz.
 */
export function createPhysicsClient(_init: PhysicsInit): PhysicsApi {
  throw new Error('not implemented: createPhysicsClient (package 1F)');
}
