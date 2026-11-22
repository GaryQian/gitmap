// The render core: WebGLRenderer, resize, the render loop, theme, the batch projection, the camera
// and the scene-module host. Everything that draws lives in a scene module (see ../README.md).
import * as THREE from 'three';
import type { ThemeMode } from '../../config';
import type { PositionBuffers } from '../../contracts/physics';
import type { FlyOpts, RenderApi, RenderEvents, RenderInit, RenderStats } from '../../contracts/render';
import { parseRef, type NodeRef, type PatchBatch } from '../../model/types';
import { Emitter, hexToRgb, maxUnitRadius } from '../../shared';
import { anchorOf, mapBounds } from './anchor';
import { CameraRig } from './camera';
import { createModules } from './modules';
import { PointerRouter, type PointerHandler, type PointerInfo } from './pointer';
import { PositionTextures } from './positions';
import { RefreshEstimator, pump, type Steps } from './staged';
import { RENDER_LOCAL } from './tunables';
import { TwoFingerGesture } from './twoFinger';
import type { FrameState, QualityState, RevealInfo, SceneContext, SceneEvents, SceneModule, SharedUniforms, ViewState } from './types';
import { UnitLookup } from './unitLookup';
import { touchedUnits, unitReader } from './unitRow';

/** What the spheres module provides under the name 'spheres' (declared here so the core need not import it). */
interface CountsService { visibleCounts(): Map<NodeRef, { visible: number; total: number }> }

export function createSceneRenderer(init: RenderInit): RenderApi {
  const { canvas, config, replica } = init;
  const reducedMotion = !!init.reducedMotion;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
  const scene = new THREE.Scene();
  const events = new Emitter<RenderEvents>();
  const bus = new Emitter<SceneEvents>();
  const t0 = performance.now();
  let theme: ThemeMode = init.theme;
  let disposed = false;

  const vec = () => new THREE.Vector3();
  const noTexture = null as unknown as THREE.DataTexture; // replaced below, before any material exists
  const uniforms: SharedUniforms = {
    uTime: { value: 0 }, uPixelRatio: { value: 1 }, uViewport: { value: new THREE.Vector2(1, 1) }, uPixelWorld: { value: 1 },
    uDark: { value: 1 }, uVoid: { value: vec() }, uDustCool: { value: vec() }, uDustWarm: { value: vec() },
    uText: { value: vec() }, uHalo: { value: vec() }, uWarm: { value: vec() },
    uPosUnit: { value: noTexture }, uPosDistrict: { value: noTexture }, uPosCity: { value: noTexture },
    uUnitInfo: { value: noTexture }, uUnitColor: { value: noTexture },
    uAggregate: { value: new THREE.Vector4(0, 0, 0, 0) }, uAggregateKeep: { value: 0 },
  };
  const applyThemeUniforms = () => {
    const t = config.theme[theme];
    uniforms.uDark.value = theme === 'dark' ? 1 : 0;
    uniforms.uVoid.value.set(...hexToRgb(t.void));
    uniforms.uDustCool.value.set(...hexToRgb(t.dustCool));
    uniforms.uDustWarm.value.set(...hexToRgb(t.dustWarm));
    uniforms.uText.value.set(...hexToRgb(t.text));
    uniforms.uHalo.value.set(...hexToRgb(t.halo));
    uniforms.uWarm.value.set(...hexToRgb(t.warm));
    renderer.setClearColor(t.void, 1);
  };
  applyThemeUniforms();

  const positions = new PositionTextures(init.positions, uniforms);
  const units = new UnitLookup(uniforms, config.visual, replica.table('unit').capacity);
  const rig = new CameraRig(config.camera);
  rig.topHeight = 2 * maxUnitRadius(config.visual);
  const pointer = new PointerRouter(canvas);
  const state: ViewState = {
    revealed: false, selection: [], highlights: [], typeFilter: [], minBytes: config.legend.minBytesDefault, overlay: null,
    particles: init.particles ?? config.settings.particles,
    ribbons: true,
    poiBeams: true,
  };
  const counters = { edgesDrawn: 0, quality: 0 };
  const quality: QualityState = { edgeScale: 1, maxPixelRatio: Infinity };
  const services = new Map<string, unknown>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const pending = new Set<() => void>(); // resolvers of promises still open, settled on dispose

  // ---- loop state ----
  let raf = 0;
  let lastRaf = 0, lastRender = 0, animateUntil = 0;
  let dirty = true;
  let wasMoving = false;
  let size = { w: 0, h: 0, dpr: 0 };
  const deltas: number[] = [];
  let deltaSum = 0;
  /** What adaptive quality is told about frame timing (FrameState.active, frameMs, refreshMs). */
  const refresh = new RefreshEstimator();
  let prevRendered = false, skipTiming: number = RENDER_LOCAL.loop.settleFrames;
  let hovering = false;
  /** The camera frames the whole map by itself until the reveal or the first user input. */
  let autoFrame = true;

  const ctx: SceneContext = {
    canvas, renderer, scene, camera: rig.camera, config, replica, reducedMotion,
    get theme() { return theme; },
    uniforms, positions, units, rig, pointer, bus, state, counters, quality,
    now: () => (performance.now() - t0) / 1000,
    anchor: (ref) => anchorOf(ref, replica, positions.buffers, config.visual),
    emit: (evt, e) => events.emit(evt, e),
    invalidate: () => { dirty = true; },
    animate: (ms) => { animateUntil = Math.max(animateUntil, performance.now() + ms); },
    provide: (name, api) => { services.set(name, api); },
    service: <T>(name: string) => services.get(name) as T | undefined,
  };

  // ---- camera input: the lowest-priority pointer handler ----
  let drag: 'pan' | 'orbit' | null = null;
  let last: PointerInfo | null = null;
  let fingers: TwoFingerGesture | null = null;
  const cameraHandler: PointerHandler = {
    name: 'camera',
    priority: 0,
    down(p) {
      if (p.button === 1 || (p.button === 0 && p.space)) { drag = 'orbit'; rig.orbitStart(p.x, p.y); }
      else if (p.button === 0 && !p.shift) { drag = 'pan'; rig.panStart(p.x, p.y); }
      else return false;
      last = p;
      return true;
    },
    move(p, captured) {
      if (!captured || !drag || !last) return;
      if (drag === 'pan') rig.panMove(p.x, p.y); else rig.orbitMove(p.x - last.x, p.y - last.y);
      last = p;
      autoFrame = false;
    },
    up() { rig.dragEnd(); drag = null; last = null; dirty = true; },
    wheel(w) {
      // a trackpad pinch arrives as ctrl+wheel with small deltas
      const travel = Math.max(-300, Math.min(300, w.deltaY)) * (w.ctrl ? 4 : 1);
      rig.zoomAt(w.x, w.y, Math.exp(travel * RENDER_LOCAL.camera.zoomSpeed), performance.now());
      autoFrame = false;
      return true;
    },
    pinch(g) {
      if (g.phase === 'start') { drag = null; last = null; fingers = new TwoFingerGesture(g); rig.pinchStart(g.x, g.y); }
      else if (g.phase === 'move') {
        // tilt, or zoom + turn + pan: core/twoFinger.ts decides which once the fingers have moved a little
        const step = fingers?.move(g);
        if (step?.kind === 'tilt') rig.pinchTilt(step.dy);
        else if (step) rig.pinchMove(step.x, step.y, step.factor, step.turn);
        if (step) autoFrame = false;
      } else { fingers = null; rig.dragEnd(); }
      dirty = true;
      return true;
    },
  };
  pointer.add(cameraHandler);

  // ---- modules ----
  const modules: SceneModule[] = [];
  const each = (what: string, fn: (m: SceneModule) => void) => {
    for (const m of modules) {
      try { fn(m); } catch (err) { console.error(`[render] module "${m.name}" failed in ${what}`, err); }
    }
  };

  // ---- sizing ----
  /** The display's pixel ratio, capped by config and by what adaptive quality allows. */
  const wantedDpr = () => Math.min(window.devicePixelRatio || 1, config.render.maxDpr, Math.max(quality.maxPixelRatio, 0.5));
  function resize(): void {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const dpr = wantedDpr();
    if (w === size.w && h === size.h && dpr === size.dpr) return;
    skipTiming = RENDER_LOCAL.loop.settleFrames;
    const atDefault = autoFrame || rig.isDefaultView();
    size = { w, h, dpr };
    if (!w || !h) return;
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    uniforms.uPixelRatio.value = dpr;
    renderer.getDrawingBufferSize(uniforms.uViewport.value);
    uniforms.uPixelWorld.value = (2 * Math.tan((rig.camera.fov * Math.PI) / 360)) / uniforms.uViewport.value.y;
    rig.setViewport(w, h);
    if (atDefault) rig.snapTo(rig.defaultView());
    each('resize', (m) => m.resize?.(w, h, dpr));
    dirty = true;
  }
  const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => resize()) : null;
  observer?.observe(canvas);

  function updateBounds(): void {
    const b = mapBounds(replica, positions.buffers);
    if (b && b.r > 0) rig.bounds = b;
    if (autoFrame) rig.snapTo(rig.defaultView());
  }

  // ---- the batch projection ----
  let lastRev = replica.rev;
  let resyncs = 0;
  /** A batch arrived before the replica applied it: rebuild as soon as the replica has caught up. */
  let awaitingReplica = false;

  function projectOnce(batch: PatchBatch, rebuild: boolean): void {
    const read = unitReader(replica, config.visual);
    const capacity = replica.table('unit').capacity;
    const touched = rebuild ? null : touchedUnits(batch);
    if (!touched || touched.all) units.rebuild(capacity, read);
    else for (const s of touched.slots) units.write(s, read);
    for (const m of modules) m.applyBatch?.(batch, { rebuild });
  }

  function project(batch: PatchBatch, rebuild: boolean): void {
    awaitingReplica = false;
    try {
      projectOnce(batch, rebuild);
    } catch (err) {
      // a handler that throws leaves a suspect scene: rebuild it from the replica instead (PLAN.md §5.1)
      console.error('[render] batch handler failed; resyncing from the replica', err);
      resyncs++;
      try { projectOnce(batch, true); } catch (err2) { console.error('[render] resync failed', err2); }
    }
    updateBounds();
    dirty = true;
  }

  const rebuildBatch = (): PatchBatch => ({ rev: lastRev, baseRev: lastRev, ops: [], full: true });

  /**
   * The rebuild of a large map, spread over animation frames (./staged.ts) so that no single task
   * holds the main thread for long. While it runs nothing is drawn, so a half-applied batch is
   * never on screen: the last frame stays up until the rebuild is whole.
   */
  let staged: { job: Steps; restarts: number } | null = null;

  function* rebuildSteps(batch: PatchBatch): Steps {
    const read = unitReader(replica, config.visual);
    const capacity = replica.table('unit').capacity;
    units.ensure(capacity);
    units.info.fill(0); units.color.fill(0);
    for (let from = 0; from < capacity; from += RENDER_LOCAL.staging.unitChunk) {
      const to = Math.min(capacity, from + RENDER_LOCAL.staging.unitChunk);
      for (let s = from; s < to; s++) units.write(s, read);
      yield;
    }
    for (const m of modules) {
      if (!m.applyBatch) continue;
      m.applyBatch(batch, { rebuild: true });
      yield;
    }
  }

  /** Project a batch now; or, for the rebuild of a large map while the loop runs, over the next few frames. */
  function beginProject(batch: PatchBatch, rebuild: boolean): void {
    if (staged) {
      // the model changed under a rebuild in progress: start again from the replica, once; then stop staging
      const restarts = staged.restarts + 1;
      staged = null;
      if (restarts > 1) project(rebuildBatch(), true);
      else { awaitingReplica = false; staged = { job: rebuildSteps(rebuildBatch()), restarts }; }
      return;
    }
    if (rebuild && raf !== 0 && replica.table('unit').capacity >= RENDER_LOCAL.staging.minUnits) {
      awaitingReplica = false;
      staged = { job: rebuildSteps(batch), restarts: 0 };
      return;
    }
    project(batch, rebuild);
  }

  /** One slice of the staged rebuild. True once it is complete and the scene may be drawn again. */
  function advanceStaged(): boolean {
    try {
      if (!pump(staged!.job, config.render.patchBudgetMs)) return false;
      staged = null;
      updateBounds();
      dirty = true;
    } catch (err) {
      console.error('[render] batch handler failed; resyncing from the replica', err);
      resyncs++;
      staged = null;
      project(rebuildBatch(), true);
    }
    return true;
  }

  /** Finish a staged rebuild at once (the caller needs the scene to match the model now). */
  function flushStaged(): void {
    if (!staged) return;
    staged = null;
    project(rebuildBatch(), true);
  }

  // ---- frame ----
  function tick(nowMs: number): void {
    raf = requestAnimationFrame(tick);
    const delta = nowMs - lastRaf;
    lastRaf = nowMs;
    if (delta > 0 && delta < 500) {
      deltas.push(delta); deltaSum += delta;
      if (deltas.length > RENDER_LOCAL.loop.statFrames) deltaSum -= deltas.shift()!;
    }
    if (delta > 0) refresh.add(delta);
    if (wantedDpr() !== size.dpr) resize();
    if (!size.w || !size.h) { prevRendered = false; return; }
    if (awaitingReplica && replica.rev >= lastRev) beginProject(rebuildBatch(), true);
    // a large rebuild in progress: do a slice of it, and keep the last frame on screen until it is whole
    if (staged && !advanceStaged()) { prevRendered = false; return; }

    const moved = positions.sync();
    if (moved) {
      updateBounds();
      each('onPositions', (m) => m.onPositions?.());
    }
    rig.update(nowMs);
    const moving = rig.isMoving(nowMs) || pointer.dragging;
    if (moving !== wasMoving) {
      wasMoving = moving;
      events.emit('camera', { moving });
      bus.emit('camera', { moving });
    }
    const active = moving || moved || rig.changed || dirty || hovering || positions.hot() || nowMs < animateUntil;
    if (!active) {
      // nothing moves: ambient shimmer only, at a reduced rate (none at all under reduced motion)
      if (reducedMotion || nowMs - lastRender < 1000 / RENDER_LOCAL.loop.idleFps - 1) { prevRendered = false; return; }
    }
    // frame timing for adaptive quality: only between two frames that were both drawn, and not while the loop settles
    const timed = prevRendered && skipTiming <= 0 && delta > 0 && delta < 500;
    if (skipTiming > 0) skipTiming--;
    prevRendered = true;
    dirty = false;
    rig.changed = false;
    const time = (nowMs - t0) / 1000;
    const frame: FrameState = {
      time, nowMs, dt: Math.min(0.1, Math.max(0, (nowMs - lastRender) / 1000)), moving,
      active, frameMs: timed ? delta : 0, refreshMs: refresh.ms,
      cameraDistance: rig.view.distance, target: { x: rig.view.x, z: rig.view.z },
      width: size.w, height: size.h, pixelRatio: size.dpr,
    };
    lastRender = nowMs;
    uniforms.uTime.value = time;
    each('frame', (m) => m.frame?.(frame));
    renderer.render(scene, rig.camera);
    events.emit('frame', { time: nowMs, frameMs: delta > 0 && delta < 500 ? delta : 0, moving, cameraDistance: frame.cameraDistance, target: frame.target });
  }

  function start(): void {
    if (raf || disposed || document.hidden) return;
    lastRaf = performance.now();
    prevRendered = false;
    skipTiming = RENDER_LOCAL.loop.settleFrames;
    refresh.reset();
    dirty = true;
    raf = requestAnimationFrame(tick);
  }
  function stop(): void {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }
  const onVisibility = () => { if (document.hidden) stop(); else start(); };
  document.addEventListener('visibilitychange', onVisibility);
  const onContextLost = (e: Event) => { e.preventDefault(); stop(); };
  const onContextRestored = () => { start(); };
  canvas.addEventListener('webglcontextlost', onContextLost);
  canvas.addEventListener('webglcontextrestored', onContextRestored);

  // ---- helpers for the public API ----
  const openPromise = (arm: (resolve: () => void) => void): Promise<void> => new Promise<void>((resolve) => {
    const done = () => { pending.delete(done); resolve(); };
    pending.add(done);
    arm(done);
  });
  const flyMs = (opts?: FlyOpts) => (reducedMotion ? 0 : Math.max(0, opts?.ms ?? config.camera.flyMs));
  const setState = <K extends keyof ViewState & keyof SceneEvents>(key: K, value: ViewState[K] & SceneEvents[K]) => {
    state[key] = value;
    bus.emit(key, value);
    dirty = true;
  };

  const api: RenderApi = {
    applyBatch(batch) {
      if (disposed) return;
      const gap = !batch.full && batch.baseRev !== lastRev;
      if (gap) {
        resyncs++;
        console.warn(`[render] revision gap: batch ${batch.baseRev}→${batch.rev} on top of ${lastRev}; resyncing from the replica`);
      }
      lastRev = batch.rev;
      if (replica.rev < batch.rev) { awaitingReplica = true; dirty = true; return; }
      beginProject(batch, !!batch.full || gap || awaitingReplica);
    },

    setPositions(buffers: PositionBuffers) {
      if (disposed) return;
      positions.setBuffers(buffers);
      dirty = true;
    },

    reveal(opts) {
      if (disposed) return Promise.resolve();
      const instant = !!opts?.instant || reducedMotion;
      if (state.revealed && !instant) return Promise.resolve();
      flushStaged(); // the reveal starts from the whole model
      state.revealed = true;
      positions.sync();
      updateBounds(); // frames the map one last time while autoFrame is still on
      autoFrame = false;
      const info: RevealInfo = { instant, at: ctx.now(), durationMs: instant ? 0 : config.reveal.growMs };
      each('reveal', (m) => m.reveal?.(info));
      bus.emit('reveal', info);
      ctx.animate(info.durationMs + 200);
      dirty = true;
      if (instant) return Promise.resolve();
      return openPromise((done) => {
        const t = setTimeout(() => { timers.delete(t); done(); }, info.durationMs);
        timers.add(t);
      });
    },

    setTheme(mode) {
      if (disposed || mode === theme) return;
      theme = mode;
      applyThemeUniforms();
      each('setTheme', (m) => m.setTheme?.(mode));
      bus.emit('theme', mode);
      dirty = true;
    },

    setParticles(on) { setState('particles', on); },
    setRibbons(on) { setState('ribbons', on); },
    setPoiBeams(on) { setState('poiBeams', on); },
    setOverlay(overlay) { setState('overlay', overlay); },
    setSelection(refs) { setState('selection', refs.slice()); },
    setHighlights(refs) { setState('highlights', refs.slice()); },
    setTypeFilter(langs) { setState('typeFilter', langs.slice()); },
    setMinBytes(n) { setState('minBytes', Math.max(0, n)); },

    flyTo(ref, opts) {
      const a = disposed ? null : ctx.anchor(ref);
      if (!a) return Promise.resolve();
      autoFrame = false;
      const isUnit = parseRef(ref).kind === 'unit' || parseRef(ref).kind === 'file';
      const distance = opts?.distance ?? (isUnit ? Math.max(config.camera.minDistance, a.r * RENDER_LOCAL.camera.unitFocusRadii) : rig.distanceToFit(a.r));
      return openPromise((done) => { void rig.flyTo({ x: a.x, z: a.z, distance }, flyMs(opts), performance.now()).then(done); });
    },

    flyToFit(refs, opts) {
      if (disposed) return Promise.resolve();
      const found = [];
      for (const ref of refs) { const a = ctx.anchor(ref); if (a) found.push(a); }
      if (found.length === 0) return Promise.resolve();
      if (found.length === 1) return api.flyTo(refs.find((r) => ctx.anchor(r)) ?? refs[0], opts);
      // the ground circle around all of them: centred on their bounding box, reaching past each one's edge
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const a of found) { minX = Math.min(minX, a.x); maxX = Math.max(maxX, a.x); minZ = Math.min(minZ, a.z); maxZ = Math.max(maxZ, a.z); }
      const x = (minX + maxX) / 2, z = (minZ + maxZ) / 2;
      let radius = 0, largest = 0;
      for (const a of found) { radius = Math.max(radius, Math.hypot(a.x - x, a.z - z) + a.r); largest = Math.max(largest, a.r); }
      autoFrame = false;
      // never closer than one of them would be framed on its own
      const close = Math.max(config.camera.minDistance, largest * RENDER_LOCAL.camera.unitFocusRadii);
      const distance = opts?.distance ?? Math.min(config.camera.maxDistance, Math.max(close, rig.distanceToFit(radius)));
      return openPromise((done) => { void rig.flyTo({ x, z, distance }, flyMs(opts), performance.now()).then(done); });
    },

    resetView(opts) {
      if (disposed) return Promise.resolve();
      autoFrame = false;
      return openPromise((done) => { void rig.flyTo(rig.defaultView(), flyMs(opts), performance.now()).then(done); });
    },

    isDefaultView: () => autoFrame || rig.isDefaultView(),

    setViewInset({ right }) {
      if (disposed) return;
      // a map that was framed whole stays framed whole in the space that is left
      const atDefault = autoFrame || rig.isDefaultView();
      const ms = reducedMotion ? 0 : RENDER_LOCAL.camera.insetMs;
      rig.setInsetRight(right, ms, performance.now());
      if (autoFrame) rig.snapTo(rig.defaultView());
      else if (atDefault) void rig.flyTo(rig.defaultView(), ms, performance.now());
      dirty = true;
    },

    project(ref) {
      const a = ctx.anchor(ref);
      return a ? rig.project(a.x, a.y, a.z) : null;
    },

    screenToGround: (x, y) => rig.groundAt(x, y),

    visibleCounts: () => ctx.service<CountsService>('spheres')?.visibleCounts() ?? new Map(),

    burst(ref, kind) {
      if (disposed) return;
      bus.emit('burst', { ref, kind });
      dirty = true;
    },

    on: (evt, fn) => events.on(evt, fn),

    stats(): RenderStats {
      const frameMs = deltas.length ? deltaSum / deltas.length : 0;
      return {
        fps: frameMs > 0 ? 1000 / frameMs : 0, frameMs, spheres: replica.table('unit').count,
        edgesDrawn: counters.edgesDrawn, quality: counters.quality, resyncs,
      };
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      stop();
      staged = null;
      document.removeEventListener('visibilitychange', onVisibility);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.removeEventListener('webglcontextrestored', onContextRestored);
      observer?.disconnect();
      for (const t of timers) clearTimeout(t);
      timers.clear();
      rig.cancelFlight();
      for (const done of [...pending]) done();
      pointer.dispose();
      for (const m of [...modules].reverse()) {
        try { m.dispose(); } catch (err) { console.error(`[render] module "${m.name}" failed in dispose`, err); }
      }
      modules.length = 0;
      scene.clear();
      positions.dispose();
      units.dispose();
      services.clear();
      events.clear();
      bus.clear();
      renderer.dispose();
    },
  };

  // ---- go ----
  try {
    for (const m of createModules()) {
      m.init(ctx);
      modules.push(m);
    }
  } catch (err) {
    api.dispose();
    throw err;
  }
  // a hovered sphere's connections carry pulses: keep the full rate while one is hovered (PLAN.md §8.5)
  bus.on('hover', (h) => { hovering = h.slot >= 0 && !reducedMotion; });
  resize();
  start();
  if (replica.rev > 0) beginProject(rebuildBatch(), true);
  return api;
}
