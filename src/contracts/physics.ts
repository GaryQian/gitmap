// Tiered layout: commands in, position buffers out (PLAN.md §7). Implemented by src/physics.
import type { Config } from '../config';
import type { LayoutSnapshot, NodeRef, PatchBatch } from '../model/types';

export type Vec2 = { x: number; z: number };

/**
 * Positions, indexed by the store's slots. World position of a unit =
 * city(x, z) + district(x, z) + unit(x, z); the renderer composes this on the GPU.
 * The arrays are views over SharedArrayBuffers when `shared` is true; otherwise the physics client
 * keeps them up to date from worker messages.
 */
export interface PositionBuffers {
  readonly shared: boolean;
  /** [x, z] per unit slot, local to its district centre. */
  readonly unit: Float32Array;
  /** [x, z, r] per district slot, local to its city centre. r = territory radius. */
  readonly district: Float32Array;
  /** [x, z, r] per city slot, world coordinates. */
  readonly city: Float32Array;
  /**
   * Counters (read with Atomics.load when shared):
   *   [GEN_REV]        model revision physics has applied
   *   [GEN_ANY]        bumped on every write
   *   [GEN_HOT]        number of hot simulations (0 = everything asleep)
   *   [GEN_CITY]       bumped when any city row changed
   *   [GEN_DISTRICT0 + d]  bumped when district slot d's own row or any of its units' rows changed
   */
  readonly gen: Int32Array;
}
export const GEN_REV = 0, GEN_ANY = 1, GEN_HOT = 2, GEN_CITY = 3, GEN_DISTRICT0 = 4;

export interface PhysicsCapacity { units: number; districts: number; cities: number }

export interface PhysicsInit {
  config: Config;
  /** Buffer sizes in slots. Batches that exceed them make the engine grow its buffers (see onBuffers). */
  capacity: PhysicsCapacity;
  /** Seed for initial placement jitter. Default config.clustering.seed. */
  seed?: number;
}

export interface SettleReport {
  ms: number;
  ticks: number;
  /** False when the time cap ended the settle before every sim reached rest. */
  atRest: boolean;
  /** Share of units overlapping another unit after settling, 0..1. Reported, not asserted. */
  overlapShare: number;
}

export interface PhysicsApi {
  /** Current buffers. Replaced (and onBuffers fired) only when capacity grows. */
  readonly positions: PositionBuffers;
  onBuffers(fn: (buffers: PositionBuffers) => void): () => void;
  /**
   * Consume the same batch stream as the renderer: units, edges, districts, cities, assign.
   * New nodes are placed beside a linked neighbour or near their parent centre; affected sims get a
   * gentle reheat (config.physics.reheat) unless a settle or loadLayout follows.
   */
  applyBatch(batch: PatchBatch): void;
  /**
   * Run every simulation to rest without rendering, under a time cap, and mark home. Lower tiers
   * settle first so each tier is sized from settled content: files, then districts, then cities.
   */
  settle(maxMs: number): Promise<SettleReport>;
  /** Pin a city or district ('c:…' / 'd:…') at a world position and heat its tier. Districts are clamped to their city. */
  drag(ref: NodeRef, x: number, z: number): void;
  release(ref: NodeRef): void;
  /** Clear pins and ease cities and districts back to their home positions (~600 ms). Sims stay asleep. */
  resetLayout(): Promise<void>;
  /** True when every city and district is at its home position. */
  isAtHome(): boolean;
  /** Camera focus, for ordering simulation work by distance. */
  setFocus(target: Vec2, radius: number): void;
  /** Current positions and home positions by permanent id, for snapshots. */
  getLayout(): Promise<LayoutSnapshot>;
  /** Restore saved positions for entities already added by applyBatch. Everything is left asleep. */
  loadLayout(layout: LayoutSnapshot): void;
  dispose(): void;
}

/**
 * The in-process engine (Node pipeline, tests, and inside the physics worker). `step` runs one
 * scheduler slice of at most `maxMs` and returns the number of sims still hot.
 */
export interface PhysicsEngine extends PhysicsApi {
  step(maxMs: number): number;
}
