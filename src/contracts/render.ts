// The renderer: imperative, no React inside (PLAN.md §4, §8, §9). Implemented by src/render.
import type { Config, ThemeMode } from '../config';
import type { LangId, NodeRef, PatchBatch } from '../model/types';
import type { PositionBuffers, Vec2 } from './physics';
import type { ModelReplica } from './store';

export interface RenderInit {
  canvas: HTMLCanvasElement;
  config: Config;
  /** The main-thread replica. The renderer reads it (never writes) to resolve slots, ids and columns. */
  replica: ModelReplica;
  positions: PositionBuffers;
  theme: ThemeMode;
  particles?: boolean;
  /** Honour prefers-reduced-motion: no drift, no ambient particles, instant transitions. */
  reducedMotion?: boolean;
}

/** One colour stop of an overlay ramp. t is in 0..1 across the layer's domain. */
export interface ColorStop { t: number; color: string }
/** What the renderer needs to draw an overlay: values per unit slot and how to colour them. */
export interface OverlayView {
  id: string;
  /** One value per unit slot; NaN = not yet known (drawn in the neutral "unknown" style). */
  values: Float32Array;
  domain: [number, number];
  /** Sorted by t. With `discrete`, values snap to the nearest stop instead of interpolating. */
  stops: ColorStop[];
  discrete?: boolean;
  /** Colour for unknown values. */
  unknown: string;
}

export interface FlyOpts { ms?: number; distance?: number }

export interface ScreenPoint { x: number; y: number; visible: boolean; /** Camera distance, world units. */ depth: number }

/** Per-frame information for DOM layers that track the scene (pills, tooltips, cards). */
export interface FrameInfo {
  time: number;
  frameMs: number;
  /** True while the camera is moving or a drag is in progress. */
  moving: boolean;
  /** Distance from the camera to its ground target; drives level of detail. */
  cameraDistance: number;
  /** Ground point the camera looks at. */
  target: Vec2;
}

export interface RenderEvents {
  /** Pointer rests on a sphere (after config.interaction.hoverDelayMs) or leaves it (ref null). Client coordinates. */
  hover: { ref: NodeRef | null; x: number; y: number };
  /** Click on a sphere, or on empty space (ref null). */
  click: { ref: NodeRef | null; shift: boolean; x: number; y: number };
  dblclick: { ref: NodeRef; x: number; y: number };
  /** Shift+drag rectangle released: the unit refs inside it. */
  marquee: { refs: NodeRef[] };
  /** Fired once per rendered frame, after drawing. */
  frame: FrameInfo;
  /** Camera started or stopped moving. */
  camera: { moving: boolean };
}

export interface RenderStats {
  fps: number;
  frameMs: number;
  spheres: number;
  edgesDrawn: number;
  /** Current adaptive quality step, 0 = full. */
  quality: number;
  resyncs: number;
}

export interface RenderApi {
  /** Project a batch into buffers. Never draws a half-applied batch. Resyncs itself from the replica on a revision gap. */
  applyBatch(batch: PatchBatch): void;
  /** Positions buffers were reallocated by physics. */
  setPositions(positions: PositionBuffers): void;
  /** Grow the settled map in place, city by city (config.reveal.growMs). Before this, nothing is drawn but the background. */
  reveal(opts?: { instant?: boolean }): Promise<void>;
  setTheme(mode: ThemeMode): void;
  setParticles(on: boolean): void;
  setOverlay(overlay: OverlayView | null): void;
  setSelection(refs: NodeRef[]): void;
  /** Extra emphasis without selection (tour highlights). */
  setHighlights(refs: NodeRef[]): void;
  /** Languages to show at full strength; others dim. Empty = all. */
  setTypeFilter(langs: LangId[]): void;
  /** Hide units below this line count (glowing units exempt). Layout does not change. */
  setMinLines(n: number): void;
  flyTo(ref: NodeRef, opts?: FlyOpts): Promise<void>;
  /** Fly to the default framing: the whole map in view at the default tilt. */
  resetView(opts?: FlyOpts): Promise<void>;
  isDefaultView(): boolean;
  /** Screen position (CSS pixels relative to the canvas) of a node's anchor, or null if it does not exist. */
  project(ref: NodeRef): ScreenPoint | null;
  /** World ground point under a canvas-relative pixel, or null when the ray misses the plane. */
  screenToGround(x: number, y: number): Vec2 | null;
  /** Units visible (not hidden by the size slider) per city ref, for pills. */
  visibleCounts(): Map<NodeRef, { visible: number; total: number }>;
  /** A burst effect: 'select' on click, 'open' on double-click (PLAN.md §8.6). */
  burst(ref: NodeRef, kind: 'select' | 'open'): void;
  on<E extends keyof RenderEvents>(evt: E, fn: (e: RenderEvents[E]) => void): () => void;
  stats(): RenderStats;
  dispose(): void;
}

/** The wisp background on its own, for the landing page and waiting screen (PLAN.md §17.4). */
export interface BackgroundApi {
  setTheme(mode: ThemeMode): void;
  /** 0..1: brightens the wisps slightly (drag-over feedback on the landing page). */
  setEmphasis(amount: number): void;
  dispose(): void;
}
