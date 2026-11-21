// The wisp background on its own small canvas, for the landing page and waiting screen
// (PLAN.md §17.4). Same shader as the scene's background. Static under reduced motion; a flat
// painted approximation when WebGL is unavailable.
import * as THREE from 'three';
import type { Config, ThemeMode } from '../../config';
import type { BackgroundApi } from '../../contracts/render';
import { RENDER_LOCAL } from '../core/tunables';
import { FULLSCREEN_VERT, WISP_FRAG, createWispUniforms, fullscreenTriangle, setWispTheme, wispContrast, wispDrift } from './wisps';

export interface BackgroundOptions { config: Config; theme: ThemeMode; reducedMotion?: boolean }

const B = RENDER_LOCAL.background;

export function createStandaloneBackground(canvas: HTMLCanvasElement, opts: BackgroundOptions): BackgroundApi {
  const { config } = opts;
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'low-power' });
  } catch {
    return paintedBackground(canvas, opts);
  }
  const wisps = config.theme.wisps;
  const uniforms = createWispUniforms(wisps);
  let mode = opts.theme;
  const applyTheme = () => {
    setWispTheme(uniforms, config.theme, mode);
    uniforms.uStarAmount.value = mode === 'dark' && wisps.stars ? 1 : 0;
  };
  applyTheme();
  uniforms.uStarCell.value = 2;

  const scene = new THREE.Scene();
  const camera = new THREE.Camera();
  const geometry = fullscreenTriangle();
  const material = new THREE.ShaderMaterial({ uniforms, vertexShader: FULLSCREEN_VERT, fragmentShader: WISP_FRAG, depthTest: false, depthWrite: false });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  scene.add(mesh);

  const t0 = performance.now();
  let raf = 0, lastDraw = -Infinity, dirty = true, disposed = false;
  let width = 0, height = 0;

  function resize(): void {
    const w = Math.max(2, Math.round(canvas.clientWidth * B.standaloneScale)), h = Math.max(2, Math.round(canvas.clientHeight * B.standaloneScale));
    if (w === width && h === height) return;
    width = w; height = h;
    renderer.setPixelRatio(1);
    renderer.setSize(w, h, false);
    uniforms.uRes.value.set(w, h);
    dirty = true;
  }

  function draw(now: number): void {
    if (!canvas.clientWidth || !canvas.clientHeight) return;
    uniforms.uDrift.value = opts.reducedMotion ? 0 : wispDrift(wisps, (now - t0) / 1000);
    renderer.render(scene, camera);
    lastDraw = now;
    dirty = false;
  }

  function tick(now: number): void {
    raf = requestAnimationFrame(tick);
    // the drift is slow: a low frame rate is plenty, and under reduced motion only changes are drawn
    if (dirty || (!opts.reducedMotion && now - lastDraw >= 1000 / B.standaloneFps - 1)) draw(now);
  }
  const start = () => { if (!raf && !disposed && !document.hidden) raf = requestAnimationFrame(tick); };
  const stop = () => { if (raf) cancelAnimationFrame(raf); raf = 0; };
  const onVisibility = () => { if (document.hidden) stop(); else { dirty = true; start(); } };
  document.addEventListener('visibilitychange', onVisibility);
  const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
  observer?.observe(canvas);
  resize();
  start();

  return {
    setTheme(next) {
      if (disposed || next === mode) return;
      mode = next;
      applyTheme();
      dirty = true;
    },
    setEmphasis(amount) {
      if (disposed) return;
      uniforms.uContrast.value = wispContrast(wisps, amount);
      dirty = true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      observer?.disconnect();
      scene.remove(mesh);
      geometry.dispose();
      material.dispose();
      renderer.dispose();
    },
  };
}

/** No WebGL: the void colour with a few soft patches of cool and warm dust, painted once per change. */
function paintedBackground(canvas: HTMLCanvasElement, opts: BackgroundOptions): BackgroundApi {
  const g = canvas.getContext('2d');
  let mode = opts.theme, emphasis = 0, disposed = false;
  const paint = () => {
    if (!g || disposed) return;
    const w = (canvas.width = Math.max(2, Math.round(canvas.clientWidth * B.standaloneScale)));
    const h = (canvas.height = Math.max(2, Math.round(canvas.clientHeight * B.standaloneScale)));
    const t = opts.config.theme[mode];
    const strength = wispContrast(opts.config.theme.wisps, emphasis);
    g.globalAlpha = 1;
    g.fillStyle = t.void;
    g.fillRect(0, 0, w, h);
    const patches: [number, number, number, string][] = [[0.25, 0.3, 0.55, t.dustCool], [0.75, 0.65, 0.6, t.dustCool], [0.6, 0.25, 0.4, t.dustWarm], [0.2, 0.8, 0.35, t.dustWarm]];
    for (const [x, y, r, color] of patches) {
      const grad = g.createRadialGradient(x * w, y * h, 0, x * w, y * h, r * Math.max(w, h));
      grad.addColorStop(0, color);
      grad.addColorStop(1, t.void);
      g.globalAlpha = Math.min(1, strength);
      g.fillStyle = grad;
      g.globalCompositeOperation = mode === 'dark' ? 'lighten' : 'darken';
      g.fillRect(0, 0, w, h);
    }
    g.globalCompositeOperation = 'source-over';
  };
  const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(paint) : null;
  observer?.observe(canvas);
  paint();
  return {
    setTheme(next) { mode = next; paint(); },
    setEmphasis(amount) { emphasis = amount; paint(); },
    dispose() { disposed = true; observer?.disconnect(); },
  };
}
