// Background and ground (PLAN.md §8.2, §17.4, §17.5): the wisp shader at reduced resolution behind
// everything, star points in dark mode, and an analytic anti-aliased grid on the plane that fades
// with distance. Drawn before the reveal too: this is all there is to see until then.
import * as THREE from 'three';
import type { ThemeMode } from '../../config';
import { RENDER_LOCAL } from '../core/tunables';
import type { FrameState, SceneContext, SceneModule } from '../core/types';
import { COMPOSITE_FRAG, FULLSCREEN_VERT, WISP_FRAG, createWispUniforms, fullscreenTriangle, wispDrift, type WispUniforms } from './wisps';

const GROUND_VERT = /* glsl */ `
varying vec3 vW;
void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;

// Three grid levels, each fading out as its cells shrink toward a few pixels, so the plane never
// turns into moiré or haze at any zoom. Starlight in dark mode (additive), ink in light mode.
const GROUND_FRAG = /* glsl */ `
uniform vec3 uText; uniform float uCell; uniform float uMajor; uniform float uOpacity; uniform float uCamDist;
varying vec3 vW;
float grid(vec2 p, float s) {
  vec2 q = p / s; vec2 fw = max(fwidth(q), vec2(1e-6));
  vec2 g = abs(fract(q - 0.5) - 0.5) / fw;
  float line = 1.0 - min(min(g.x, g.y), 1.0);
  return line * (1.0 - smoothstep(0.06, 0.30, max(fw.x, fw.y)));
}
void main() {
  float g = grid(vW.xz, uCell) * 0.5 + grid(vW.xz, uCell * uMajor) * 0.5 + grid(vW.xz, uCell * uMajor * uMajor) * 0.5;
  float fade = 1.0 - smoothstep(uCamDist * 1.2, uCamDist * 6.0, distance(cameraPosition, vW));
  float a = uOpacity * min(g, 1.0) * fade;
  if (a < 0.001) discard;
  gl_FragColor = vec4(uText, a);
}`;

export function createBackgroundModule(): SceneModule {
  let ctx!: SceneContext;
  let wisp!: WispUniforms;
  let target: THREE.WebGLRenderTarget | null = null;
  let wispMesh!: THREE.Mesh;
  let composite!: THREE.Mesh;
  let ground!: THREE.Mesh;
  const wispScene = new THREE.Scene();
  const wispCamera = new THREE.Camera();
  const disposables: { dispose(): void }[] = [];
  const compositeUniforms = { uWisps: { value: null as THREE.Texture | null }, uStarAmount: { value: 0 }, uStarCell: { value: 3 } };
  const groundUniforms = { uCell: { value: 50 }, uMajor: { value: 5 }, uOpacity: { value: 0.06 }, uCamDist: { value: 1 } };
  /** What the last wisp pass was drawn with; it is redrawn only when one of these changes. */
  let drawnKey = '';

  function init(context: SceneContext): void {
    ctx = context;
    const { config, uniforms } = ctx;
    wisp = createWispUniforms(config.theme.wisps, uniforms);

    const tri = fullscreenTriangle();
    const wispMat = new THREE.ShaderMaterial({ uniforms: wisp, vertexShader: FULLSCREEN_VERT, fragmentShader: WISP_FRAG, depthTest: false, depthWrite: false });
    wispMesh = new THREE.Mesh(tri, wispMat);
    wispMesh.frustumCulled = false;
    wispScene.add(wispMesh);

    const compositeMat = new THREE.ShaderMaterial({
      uniforms: { ...compositeUniforms, uViewport: uniforms.uViewport, uDark: uniforms.uDark },
      vertexShader: FULLSCREEN_VERT, fragmentShader: COMPOSITE_FRAG, depthTest: false, depthWrite: false,
    });
    composite = new THREE.Mesh(tri, compositeMat);
    composite.frustumCulled = false;
    composite.renderOrder = -10;
    ctx.scene.add(composite);

    groundUniforms.uCell.value = config.visual.grid.cell;
    groundUniforms.uMajor.value = RENDER_LOCAL.grid.majorEvery;
    groundUniforms.uOpacity.value = config.visual.grid.opacity;
    const groundMat = new THREE.ShaderMaterial({
      uniforms: { ...groundUniforms, uText: uniforms.uText },
      vertexShader: GROUND_VERT, fragmentShader: GROUND_FRAG, transparent: true, depthWrite: false, depthTest: true,
      blending: ctx.theme === 'dark' ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    const plane = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    ground = new THREE.Mesh(plane, groundMat);
    ground.frustumCulled = false;
    ground.renderOrder = -1;
    ctx.scene.add(ground);

    disposables.push(tri, wispMat, compositeMat, groundMat, plane);
    setTheme(ctx.theme);
  }

  function setTheme(mode: ThemeMode): void {
    const stars = mode === 'dark' && ctx.config.theme.wisps.stars ? 1 : 0;
    compositeUniforms.uStarAmount.value = stars;
    (ground.material as THREE.ShaderMaterial).blending = mode === 'dark' ? THREE.AdditiveBlending : THREE.NormalBlending;
    drawnKey = '';
  }

  function resize(width: number, height: number, pixelRatio: number): void {
    const scale = RENDER_LOCAL.background.scale * pixelRatio;
    const w = Math.max(2, Math.ceil(width * scale)), h = Math.max(2, Math.ceil(height * scale));
    if (target && target.width === w && target.height === h) return;
    target?.dispose();
    target = new THREE.WebGLRenderTarget(w, h, { depthBuffer: false, stencilBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
    compositeUniforms.uWisps.value = target.texture;
    wisp.uRes.value.set(w, h);
    drawnKey = '';
  }

  function frame(f: FrameState): void {
    const view = ctx.rig.view, wisps = ctx.config.theme.wisps;
    // slight parallax against camera movement is what gives the void depth
    const k = wisps.parallax / RENDER_LOCAL.background.parallaxWorld;
    wisp.uPar.value.set(
      (view.azimuth - RENDER_LOCAL.camera.defaultAzimuth) * wisps.parallax + view.x * k,
      view.distance * Math.sin(view.elevation) * k - view.z * k,
    );
    wisp.uDrift.value = ctx.reducedMotion ? 0 : wispDrift(wisps, f.time);
    if (target) {
      const key = `${wisp.uDrift.value}|${wisp.uPar.value.x}|${wisp.uPar.value.y}|${ctx.theme}`;
      if (key !== drawnKey) {
        drawnKey = key;
        const { renderer } = ctx;
        const previous = renderer.getRenderTarget();
        renderer.setRenderTarget(target);
        renderer.render(wispScene, wispCamera);
        renderer.setRenderTarget(previous);
      }
    }
    // the ground follows the camera and is large enough to reach past where the grid has faded out
    const span = view.distance * 14 + 100;
    ground.position.set(view.x, 0, view.z);
    ground.scale.set(span, 1, span);
    groundUniforms.uCamDist.value = view.distance;
  }

  function dispose(): void {
    ctx.scene.remove(composite, ground);
    wispScene.remove(wispMesh);
    target?.dispose();
    target = null;
    for (const d of disposables) d.dispose();
    disposables.length = 0;
  }

  return { name: 'background', order: -10, init, frame, setTheme, resize, dispose };
}

export default createBackgroundModule;
