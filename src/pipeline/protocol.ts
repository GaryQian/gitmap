// Messages between the main-thread Session and the coordinator worker.
import type { Config } from '../config';
import type { PipelineEvents, RepoSource } from '../contracts/pipeline';
import type { SettleReport } from '../contracts/physics';
import type { LayoutSnapshot, RepoModel } from '../model/types';

export type ToCoordinator =
  | { type: 'start'; source: RepoSource; config: Config }
  | { type: 'reply'; id: number; ok: true; value: unknown }
  | { type: 'reply'; id: number; ok: false; error: string }
  | { type: 'call'; id: number; method: CoordinatorMethod; args: unknown[] }
  | { type: 'selectedOverlay'; layer: string | null }
  | { type: 'frame'; frameMs: number; interacting: boolean };

/** Calls the main thread makes into the coordinator, each answered with a `result`. */
export interface CoordinatorCalls {
  exportModel(layout: LayoutSnapshot): RepoModel;
  applyRefined(): void;
  update(): void;
}
export type CoordinatorMethod = keyof CoordinatorCalls;

/** Requests the coordinator makes of the main thread (which owns the physics client). */
export interface MainCalls {
  settle(maxMs: number): SettleReport;
  loadLayout(layout: LayoutSnapshot): void;
  getLayout(): LayoutSnapshot;
}
export type MainMethod = keyof MainCalls;

export type FromCoordinator =
  | { [E in keyof PipelineEvents]: { type: 'event'; evt: E; payload: PipelineEvents[E] } }[keyof PipelineEvents]
  | { type: 'request'; id: number; method: MainMethod; args: unknown[] }
  | { type: 'result'; id: number; ok: true; value: unknown }
  | { type: 'result'; id: number; ok: false; error: string }
  | { type: 'started' }
  | { type: 'failed'; message: string };
