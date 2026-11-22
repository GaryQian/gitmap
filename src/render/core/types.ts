// The scene-module mechanism (see src/render/README.md). Every feature of the scene — spheres,
// background, and next round's territory, edges, particles and interaction — is a SceneModule that
// the core discovers with import.meta.glob('../*/module.ts'). Modules never edit core files.
import type * as THREE from 'three';
import type { Config, ThemeMode } from '../../config';
import type { Vec2 } from '../../contracts/physics';
import type { OverlayView, RenderEvents } from '../../contracts/render';
import type { ModelReplica } from '../../contracts/store';
import type { LangId, NodeRef, PatchBatch } from '../../model/types';
import type { Emitter } from '../../shared';
import type { Anchor } from './anchor';
import type { CameraRig } from './camera';
import type { PointerRouter } from './pointer';
import type { PositionTextures } from './positions';
import type { UnitLookup } from './unitLookup';

/**
 * Uniforms every material may share. Spread them into a ShaderMaterial's `uniforms`: the entries
 * are the same `{ value }` objects, so the core updates every material at once (time, theme, and
 * position textures that are swapped when physics reallocates).
 */
export interface SharedUniforms {
  [name: string]: THREE.IUniform;
  /** Seconds since the renderer was created. */
  uTime: { value: number };
  uPixelRatio: { value: number };
  /** Drawing-buffer size in device pixels. */
  uViewport: { value: THREE.Vector2 };
  /** World units covered by one device pixel at view depth 1 (multiply by the depth). */
  uPixelWorld: { value: number };
  /** 1 in dark mode, 0 in light mode. */
  uDark: { value: number };
  /** Theme tokens as sRGB vec3 (config.theme[mode]). */
  uVoid: { value: THREE.Vector3 };
  uDustCool: { value: THREE.Vector3 };
  uDustWarm: { value: THREE.Vector3 };
  uText: { value: THREE.Vector3 };
  uHalo: { value: THREE.Vector3 };
  uWarm: { value: THREE.Vector3 };
  /** Position textures (see GLSL_POSITIONS in core/glsl.ts). */
  uPosUnit: { value: THREE.DataTexture };
  uPosDistrict: { value: THREE.DataTexture };
  uPosCity: { value: THREE.DataTexture };
  /** Per-unit lookup: [radius, district slot, city slot, glow] and [r, g, b, alive]. */
  uUnitInfo: { value: THREE.DataTexture };
  uUnitColor: { value: THREE.DataTexture };
}

/** What a module's `frame` hook receives, once per rendered frame, before the scene is drawn. */
export interface FrameState {
  /** Seconds since the renderer was created; equals `uniforms.uTime.value`. */
  time: number;
  /** `performance.now()` timestamp of this frame. */
  nowMs: number;
  /** Seconds since the previous rendered frame (clamped). */
  dt: number;
  /** The camera is moving or a drag is in progress. */
  moving: boolean;
  cameraDistance: number;
  target: Vec2;
  /** Canvas size in CSS pixels, and the pixel ratio in use. */
  width: number;
  height: number;
  pixelRatio: number;
}

export interface BatchInfo {
  /**
   * True for a `full` batch, a revision gap or a failed handler: discard everything derived from the
   * model and rebuild it from `ctx.replica`, ignoring the batch's operations.
   */
  rebuild: boolean;
}

export interface RevealInfo {
  instant: boolean;
  /** Scene time (seconds) at which the reveal starts. */
  at: number;
  /** Length of the grow-in, ms (0 when instant). */
  durationMs: number;
}

/** View state set through RenderApi. It refers to entities by permanent id, never by slot. */
export interface ViewState {
  revealed: boolean;
  selection: NodeRef[];
  highlights: NodeRef[];
  typeFilter: LangId[];
  minLines: number;
  overlay: OverlayView | null;
  particles: boolean;
}

/** Internal events on `ctx.bus`: each fires after the matching field of `ctx.state` changed. */
export interface SceneEvents {
  reveal: RevealInfo;
  selection: NodeRef[];
  highlights: NodeRef[];
  typeFilter: LangId[];
  minLines: number;
  overlay: OverlayView | null;
  particles: boolean;
  theme: ThemeMode;
  /** RenderApi.burst(): a particles module draws it. */
  burst: { ref: NodeRef; kind: 'select' | 'open' };
  /** The camera started or stopped moving. */
  camera: { moving: boolean };
  /**
   * The hovered sphere changed (emitted by the interaction module): its unit slot and ref, or −1 and
   * null when nothing is hovered. `ctx.service<InteractionApi>('interaction')?.hoveredSlot()` reads
   * the current one.
   */
  hover: { slot: number; ref: NodeRef | null };
}

export interface SceneContext {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly config: Config;
  /** The main-thread replica. Read only; already at `batch.rev` when `applyBatch` runs. */
  readonly replica: ModelReplica;
  readonly reducedMotion: boolean;
  readonly theme: ThemeMode;
  readonly uniforms: SharedUniforms;
  /** Position buffers and their textures. `positions.buffers` is always the current PositionBuffers. */
  readonly positions: PositionTextures;
  /** Per-unit lookup textures, for shaders that address units by slot (edges, particles). */
  readonly units: UnitLookup;
  /** Camera state and maths: ground picking, projection, fly-to, bounds. */
  readonly rig: CameraRig;
  /** Pointer routing. Add a handler with a higher priority than the camera's to take input over. */
  readonly pointer: PointerRouter;
  readonly bus: Emitter<SceneEvents>;
  readonly state: Readonly<ViewState>;
  /** Numbers modules report into RenderApi.stats(). */
  readonly counters: { edgesDrawn: number; quality: number };
  /** Scene time in seconds (the clock behind uTime). */
  now(): number;
  /** World anchor of a node: a unit's centre, or a district's or city's ground centre. */
  anchor(ref: NodeRef): Anchor | null;
  /** Emit a public RenderEvents event (hover, click, dblclick, marquee). */
  emit<E extends keyof RenderEvents>(evt: E, e: RenderEvents[E]): void;
  /** Draw a frame soon (the loop idles at a reduced rate when nothing moves). */
  invalidate(): void;
  /** Keep drawing at the full rate for this long. */
  animate(ms: number): void;
  /** Share an API with other modules by name, and look one up. */
  provide(name: string, api: unknown): void;
  service<T>(name: string): T | undefined;
}

export interface SceneModule {
  /** Unique name; also the default key for `ctx.provide`. */
  readonly name: string;
  /** Hooks run in ascending order (default 0). Draw order is set with three.js `renderOrder`. */
  readonly order?: number;
  /** Create GPU resources and add objects to `ctx.scene`. Called once. */
  init(ctx: SceneContext): void;
  /** Project a batch into this module's buffers. The only place model-derived buffers are written. */
  applyBatch?(batch: PatchBatch, info: BatchInfo): void;
  /** Position textures were re-uploaded this frame (physics moved something or applied a revision). */
  onPositions?(): void;
  /** Once per rendered frame, before drawing. Offscreen passes go here. */
  frame?(frame: FrameState): void;
  /** Uniforms and blend modes only; never rebuild the scene. Shared uniforms are already updated. */
  setTheme?(mode: ThemeMode): void;
  /** The canvas changed size or pixel ratio. */
  resize?(width: number, height: number, pixelRatio: number): void;
  /** RenderApi.reveal() was called. */
  reveal?(info: RevealInfo): void;
  /** Free every GPU resource and listener the module created. */
  dispose(): void;
}

/** What a `src/render/<feature>/module.ts` file default-exports: one fresh module per renderer. */
export type SceneModuleFactory = () => SceneModule;
