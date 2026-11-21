// Public surface of src/render. Package 1G owns core/, spheres/ and background/.
import type { Config, ThemeMode } from '../config';
import type { BackgroundApi, RenderApi, RenderInit } from '../contracts/render';

/** The three.js scene on a canvas. Imperative; no React inside. */
export function createRenderer(_init: RenderInit): RenderApi {
  throw new Error('not implemented: createRenderer (package 1G)');
}

/** The wisp background alone on a small canvas (landing page, waiting screen). */
export function createBackground(_canvas: HTMLCanvasElement, _opts: { config: Config; theme: ThemeMode; reducedMotion?: boolean }): BackgroundApi {
  throw new Error('not implemented: createBackground (package 1G)');
}
