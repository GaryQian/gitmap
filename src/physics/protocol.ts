// Messages between the physics client (page) and the physics worker.
import type { Config } from '../config';
import type { PhysicsCapacity, PositionBuffers, SettleReport } from '../contracts/physics';
import type { LayoutSnapshot, NodeRef, PatchBatch } from '../model/types';

export type ToWorker =
  /** `buffers`: SharedArrayBuffer views the page allocated, or null when memory cannot be shared. */
  | { type: 'init'; config: Config; capacity: PhysicsCapacity; seed?: number; buffers: PositionBuffers | null }
  | { type: 'batch'; batch: PatchBatch }
  | { type: 'drag'; ref: NodeRef; x: number; z: number }
  | { type: 'release'; ref: NodeRef }
  | { type: 'focus'; x: number; z: number; radius: number }
  | { type: 'settle'; id: number; maxMs: number }
  /** The animated settle for Apply and Update; answered with 'settled' like 'settle'. */
  | { type: 'relayout'; id: number; maxMs: number }
  | { type: 'reset'; id: number }
  | { type: 'getLayout'; id: number }
  | { type: 'loadLayout'; layout: LayoutSnapshot }
  | { type: 'dispose' };

export type FromWorker =
  /** Shared mode: the engine outgrew its buffers; these replace them. */
  | { type: 'buffers'; buffers: PositionBuffers }
  /** Copy mode: the engine outgrew its buffers; grow yours to this capacity. */
  | { type: 'capacity'; capacity: PhysicsCapacity }
  /**
   * Copy mode: rows that changed since the last post. `city` is the whole city array when any city
   * row changed. Each listed district carries its own row and every unit row in it.
   */
  | {
    type: 'positions'; rev: number; hot: number; city: Float32Array | null;
    districtSlots: Int32Array; districtRows: Float32Array; unitSlots: Int32Array; unitXZ: Float32Array;
  }
  | { type: 'state'; atHome: boolean }
  | { type: 'settled'; id: number; report: SettleReport }
  | { type: 'resetDone'; id: number }
  | { type: 'layout'; id: number; layout: LayoutSnapshot }
  | { type: 'error'; message: string; id?: number };
