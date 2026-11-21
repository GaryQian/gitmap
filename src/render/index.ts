// Public surface of src/render. Package 1G owns core/, spheres/ and background/.
// How features plug in (scene modules) is described in ./README.md.
import type { Config, ThemeMode } from '../config';
import type { BackgroundApi, RenderApi, RenderInit } from '../contracts/render';
import { createStandaloneBackground } from './background/standalone';
import { createSceneRenderer } from './core/renderer';

export type {
  BatchInfo, FrameState, RevealInfo, SceneContext, SceneEvents, SceneModule, SceneModuleFactory, SharedUniforms, ViewState,
} from './core/types';

/** The three.js scene on a canvas. Imperative; no React inside. Throws when WebGL2 is unavailable. */
export function createRenderer(init: RenderInit): RenderApi {
  return createSceneRenderer(init);
}

/** The wisp background alone on a small canvas (landing page, waiting screen). */
export function createBackground(canvas: HTMLCanvasElement, opts: { config: Config; theme: ThemeMode; reducedMotion?: boolean }): BackgroundApi {
  return createStandaloneBackground(canvas, opts);
}
