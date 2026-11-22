// Camera state and maths: a perspective camera looking at a point on the ground. No DOM here; the
// pointer router feeds it (PLAN.md §9). Package 2F may drive the same methods from its own handler.
import * as THREE from 'three';
import type { Config } from '../../config';
import type { Vec2 } from '../../contracts/physics';
import type { ScreenPoint } from '../../contracts/render';
import type { Bounds } from './anchor';
import { RENDER_LOCAL } from './tunables';

export interface CameraView {
  /** Ground point the camera looks at. */
  x: number;
  z: number;
  /** Distance from the camera to that point. */
  distance: number;
  /** Angle of the camera around the target, radians (π/2 = camera on the +Z side). */
  azimuth: number;
  /** Angle of the camera above the ground, radians. */
  elevation: number;
}

const L = RENDER_LOCAL.camera;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

interface DiscFit { distance: number; /** Vertical extent on screen, as tan(angle) below and above the view axis. */ low: number; high: number }

/** View-space extent of a ground disc (plus `height` above it) whose centre sits `shift` toward the camera from the look-at point. */
function measureDisc(radius: number, height: number, view: { azimuth: number; elevation: number }, fovYDeg: number, aspect: number, margin: number, shift: number): DiscFit {
  const tanV = Math.tan((fovYDeg * Math.PI) / 360) * margin;
  const tanH = tanV * aspect;
  const ce = Math.cos(view.elevation), se = Math.sin(view.elevation), ca = Math.cos(view.azimuth), sa = Math.sin(view.azimuth);
  // camera basis: forward points from the camera to the look-at point; up has a positive y
  const fx = -ce * ca, fy = -se, fz = -ce * sa;
  const rx = -sa, rz = ca;
  const ux = rz * fy, uy = rx * fz - rz * fx, uz = -rx * fy;
  const steps = 48;
  const points: [number, number, number][] = []; // along, side, up
  let distance = 0;
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const px = Math.cos(a) * radius + shift * ca, pz = Math.sin(a) * radius + shift * sa;
    for (const py of [0, height]) {
      const along = px * fx + py * fy + pz * fz, side = px * rx + pz * rz, up = px * ux + py * uy + pz * uz;
      points.push([along, side, up]);
      // each point gives a lower bound on the distance at which it is inside the view
      distance = Math.max(distance, Math.abs(side) / tanH - along, Math.abs(up) / tanV - along);
    }
  }
  let low = Infinity, high = -Infinity;
  for (const [along, , up] of points) {
    const t = up / Math.max(1e-9, distance + along);
    low = Math.min(low, t); high = Math.max(high, t);
  }
  return { distance, low, high };
}

/** Camera distance at which that disc fits the viewport with the given margin. */
export function fitDistance(radius: number, height: number, view: { azimuth: number; elevation: number }, fovYDeg: number, aspect: number, margin: number, shift = 0): number {
  return measureDisc(radius, height, view, fovYDeg, aspect, margin, shift).distance;
}

/**
 * Frame a ground disc at a tilt. Looking at its centre leaves it low in the view (the near half is
 * larger on screen than the far half), so the look-at point is moved along the view direction until
 * the disc is vertically centred. Returns that shift (see fitDistance) and the fitting distance.
 */
export function fitDisc(radius: number, height: number, view: { azimuth: number; elevation: number }, fovYDeg: number, aspect: number, margin: number): { shift: number; distance: number } {
  const at = (shift: number) => measureDisc(radius, height, view, fovYDeg, aspect, margin, shift);
  // at −radius the look-at point is the disc's near edge (everything above centre); at +radius the far edge
  let lo = -radius, hi = radius;
  for (let i = 0; i < 32; i++) {
    const mid = (lo + hi) / 2, m = at(mid);
    if (m.high + m.low > 0) lo = mid; else hi = mid;
  }
  const shift = (lo + hi) / 2;
  return { shift, distance: at(shift).distance };
}

interface Flight { from: CameraView; to: CameraView; start: number; ms: number; hop: number; resolve: () => void }
interface InsetTween { from: number; to: number; start: number; ms: number }

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  readonly view: CameraView;
  /** Canvas size, CSS pixels. */
  width = 1;
  height = 1;
  /** The map's bounding circle; drives the default framing and the pan limit. */
  bounds: Bounds = { x: 0, z: 0, r: 200 };
  /** Tallest thing on the map, for the default framing. */
  topHeight = 0;
  /** Set by anything that moves the camera on the user's behalf; cleared by the loop each frame. */
  changed = true;
  private flight: Flight | null = null;
  private pan: Vec2 | null = null;
  private orbit: { pivot: Vec2; sx: number; sy: number } | null = null;
  /** A two-finger gesture is in progress; the ground point grabbed between the fingers, when the ray hit the plane. */
  private pinch: { anchor: Vec2 | null; sx: number; sy: number } | null = null;
  private lastWheel = -Infinity;
  private scratch = new THREE.Vector3();
  /**
   * Canvas pixels on the right covered by opaque chrome (the side panel). The projection is shifted
   * so the view's centre is the centre of what is left, and framing fits into that width only.
   * `inset` is what is drawn now; `insetTarget` is where it is easing to.
   */
  private inset = 0;
  private insetTarget = 0;
  private insetTween: InsetTween | null = null;

  constructor(private limits: Config['camera']) {
    this.camera = new THREE.PerspectiveCamera(L.fovDeg, 1, 1, 10000);
    this.view = { x: 0, z: 0, distance: 600, azimuth: L.defaultAzimuth, elevation: Math.atan(limits.defaultTilt) };
    this.apply();
  }

  setViewport(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.camera.aspect = this.width / this.height;
    this.apply();
  }

  /** Cover `px` on the right of the canvas, easing there over `ms`. */
  setInsetRight(px: number, ms: number, nowMs: number): void {
    const to = Math.max(0, px);
    if (to === this.insetTarget && !this.insetTween) return;
    this.insetTarget = to;
    if (ms <= 0 || to === this.inset) { this.insetTween = null; this.inset = to; this.apply(); return; }
    this.insetTween = { from: this.inset, to, start: nowMs, ms };
    this.changed = true;
  }

  /** Width over height of the part of the canvas that is not covered, once any easing is done. */
  private fitAspect(): number {
    return Math.max(1, this.width - Math.min(this.insetTarget, this.width - 1)) / this.height;
  }

  /** Write the view into the three.js camera. */
  apply(): void {
    const v = this.view, cam = this.camera;
    v.distance = clamp(v.distance, this.limits.minDistance, this.limits.maxDistance);
    v.elevation = clamp(v.elevation, L.minElevation, L.maxElevation);
    const lim = this.bounds.r * L.targetLimit;
    const dx = v.x - this.bounds.x, dz = v.z - this.bounds.z, off = Math.hypot(dx, dz);
    if (off > lim && off > 0) { v.x = this.bounds.x + (dx / off) * lim; v.z = this.bounds.z + (dz / off) * lim; }
    const ce = Math.cos(v.elevation);
    cam.position.set(v.x + v.distance * ce * Math.cos(v.azimuth), v.distance * Math.sin(v.elevation), v.z + v.distance * ce * Math.sin(v.azimuth));
    cam.up.set(0, 1, 0);
    cam.lookAt(v.x, 0, v.z);
    cam.near = Math.max(0.1, v.distance * 0.02);
    cam.far = v.distance * 60 + this.bounds.r * 4;
    cam.updateProjectionMatrix();
    if (this.inset > 0) {
      // lens shift: move the principal point left by half the inset, so the look-at point lands in
      // the middle of the uncovered part of the canvas (projectionMatrix is column-major: [8] is row 0, column 2)
      const inset = Math.min(this.inset, this.width - 1);
      cam.projectionMatrix.elements[8] += inset / this.width;
      cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    }
    cam.updateMatrixWorld(true);
    this.changed = true;
  }

  // ---- picking and projection ----

  /** World ground point under a canvas-relative pixel, or null when the ray misses the plane. */
  groundAt(x: number, y: number): Vec2 | null {
    const cam = this.camera;
    const p = this.scratch.set((x / this.width) * 2 - 1, 1 - (y / this.height) * 2, 0.5).unproject(cam);
    const dx = p.x - cam.position.x, dy = p.y - cam.position.y, dz = p.z - cam.position.z;
    if (dy > -1e-9) return null;
    const t = -cam.position.y / dy;
    return { x: cam.position.x + dx * t, z: cam.position.z + dz * t };
  }

  /** Screen position (canvas-relative CSS pixels) of a world point. */
  project(x: number, y: number, z: number): ScreenPoint {
    const cam = this.camera;
    const p = this.scratch.set(x, y, z);
    const depth = p.distanceTo(cam.position);
    p.applyMatrix4(cam.matrixWorldInverse);
    const inFront = p.z < -cam.near;
    p.applyMatrix4(cam.projectionMatrix);
    const sx = (p.x * 0.5 + 0.5) * this.width, sy = (0.5 - p.y * 0.5) * this.height;
    return { x: sx, y: sy, visible: inFront && sx >= 0 && sx <= this.width && sy >= 0 && sy <= this.height, depth };
  }

  /** World units covered by one CSS pixel at the given view depth. */
  worldPerPixel(depth: number): number {
    return (2 * Math.tan((this.camera.fov * Math.PI) / 360) * depth) / this.height;
  }

  // ---- direct manipulation ----

  /** Keep the ground point `anchor` under the canvas pixel (x, y) by shifting the target. */
  private pinGround(anchor: Vec2, x: number, y: number): void {
    const now = this.groundAt(x, y);
    if (!now) return;
    // a ray that grazes the horizon lands absurdly far away: ignore it
    if (Math.hypot(now.x - this.view.x, now.z - this.view.z) > this.view.distance * 30) return;
    this.view.x += anchor.x - now.x;
    this.view.z += anchor.z - now.z;
    this.apply();
  }

  panStart(x: number, y: number): void {
    this.cancelFlight();
    this.pan = this.groundAt(x, y);
  }
  /** The grabbed ground point stays under the cursor. */
  panMove(x: number, y: number): void {
    if (this.pan) this.pinGround(this.pan, x, y);
  }

  orbitStart(x: number, y: number): void {
    this.cancelFlight();
    this.orbit = { pivot: this.groundAt(x, y) ?? { x: this.view.x, z: this.view.z }, sx: x, sy: y };
  }
  /** Rotate around the ground point that was under the pointer when the drag began. */
  orbitMove(dx: number, dy: number): void {
    if (!this.orbit) return;
    this.view.azimuth += dx * L.orbitSpeed;
    this.view.elevation = clamp(this.view.elevation + dy * L.orbitSpeed, L.minElevation, L.maxElevation);
    this.apply();
    this.pinGround(this.orbit.pivot, this.orbit.sx, this.orbit.sy);
  }

  /** Two fingers came down, midway at (x, y). */
  pinchStart(x: number, y: number): void {
    this.cancelFlight();
    this.pan = null;
    this.orbit = null;
    this.pinch = { anchor: this.groundAt(x, y), sx: x, sy: y };
  }
  /**
   * The fingers moved: zoom by `factor` (below 1 = closer), turn the map by `turn` radians
   * (clockwise on screen, as the fingers twist) and keep the grabbed ground point midway between
   * them, so spreading zooms, twisting turns and moving both fingers pans.
   */
  pinchMove(x: number, y: number, factor: number, turn = 0): void {
    if (!this.pinch) return;
    this.view.distance *= factor;
    this.view.azimuth -= turn;
    this.apply();
    this.pinch.anchor ??= this.groundAt(x, y);
    if (this.pinch.anchor) this.pinGround(this.pinch.anchor, x, y);
  }
  /**
   * Both fingers slid `dy` pixels down (negative: up): raise the camera toward a top-down view, or
   * lower it toward the horizon, about the ground point that was between the fingers at the start.
   */
  pinchTilt(dy: number): void {
    if (!this.pinch) return;
    this.view.elevation = clamp(this.view.elevation + dy * L.orbitSpeed, L.minElevation, L.maxElevation);
    this.apply();
    if (this.pinch.anchor) this.pinGround(this.pinch.anchor, this.pinch.sx, this.pinch.sy);
  }

  dragEnd(): void {
    this.pan = null;
    this.orbit = null;
    this.pinch = null;
  }

  /** Zoom by `factor` (below 1 = closer) toward the ground point under (x, y). */
  zoomAt(x: number, y: number, factor: number, nowMs: number): void {
    this.cancelFlight();
    const anchor = this.groundAt(x, y);
    this.view.distance *= factor;
    this.apply();
    if (anchor) this.pinGround(anchor, x, y);
    this.lastWheel = nowMs;
  }

  // ---- framing ----

  /** The default framing: the whole map in view at the default tilt. */
  defaultView(): CameraView {
    const view = { azimuth: L.defaultAzimuth, elevation: Math.atan(this.limits.defaultTilt) };
    const fit = fitDisc(Math.max(this.bounds.r, 1), this.topHeight, view, this.camera.fov, this.fitAspect(), L.fitMargin);
    // the disc's centre lies `shift` toward the camera from the look-at point
    return {
      x: this.bounds.x - fit.shift * Math.cos(view.azimuth), z: this.bounds.z - fit.shift * Math.sin(view.azimuth),
      distance: clamp(fit.distance, this.limits.minDistance, this.limits.maxDistance), ...view,
    };
  }

  isDefaultView(): boolean {
    const d = this.defaultView(), v = this.view;
    const turn = Math.abs(Math.atan2(Math.sin(v.azimuth - d.azimuth), Math.cos(v.azimuth - d.azimuth)));
    return Math.hypot(v.x - d.x, v.z - d.z) <= d.distance * 0.01 && Math.abs(Math.log(v.distance / d.distance)) <= 0.01
      && turn <= 0.005 && Math.abs(v.elevation - d.elevation) <= 0.005;
  }

  /** Distance from which a ground disc of radius r fills the view at the current angles. */
  distanceToFit(r: number): number {
    return fitDistance(Math.max(r, 1), 0, this.view, this.camera.fov, this.fitAspect(), L.fitMargin);
  }

  /** Jump to a view. */
  snapTo(view: Partial<CameraView>): void {
    this.cancelFlight();
    Object.assign(this.view, view);
    this.apply();
  }

  /** Ease to a view over `ms`. Resolves when it arrives or is interrupted. */
  flyTo(to: Partial<CameraView>, ms: number, nowMs: number): Promise<void> {
    this.cancelFlight();
    this.dragEnd();
    const from = { ...this.view };
    const dest: CameraView = { ...from, ...to };
    dest.azimuth = from.azimuth + Math.atan2(Math.sin(dest.azimuth - from.azimuth), Math.cos(dest.azimuth - from.azimuth));
    if (ms <= 0) { this.snapTo(dest); return Promise.resolve(); }
    // a long trip between two close-up views pulls back on the way, so the route is visible
    const travel = Math.hypot(dest.x - from.x, dest.z - from.z);
    const hop = Math.max(0, travel * 0.6 - Math.max(from.distance, dest.distance));
    return new Promise((resolve) => { this.flight = { from, to: dest, start: nowMs, ms, hop, resolve }; this.changed = true; });
  }

  cancelFlight(): void {
    const f = this.flight;
    if (!f) return;
    this.flight = null;
    f.resolve();
  }

  /** True while a drag, a pinch, a flight or a wheel gesture is in progress. */
  isMoving(nowMs: number): boolean {
    return !!this.flight || !!this.pan || !!this.orbit || !!this.pinch || nowMs - this.lastWheel < L.wheelSettleMs;
  }

  /** Advance a flight. Call once per frame. */
  update(nowMs: number): void {
    const it = this.insetTween;
    if (it) {
      const t = clamp((nowMs - it.start) / it.ms, 0, 1);
      this.inset = it.from + (it.to - it.from) * easeInOutCubic(t);
      if (t >= 1) this.insetTween = null;
      if (!this.flight) this.apply();
    }
    const f = this.flight;
    if (!f) return;
    const t = clamp((nowMs - f.start) / f.ms, 0, 1), e = easeInOutCubic(t);
    const v = this.view, a = f.from, b = f.to;
    v.x = a.x + (b.x - a.x) * e;
    v.z = a.z + (b.z - a.z) * e;
    v.distance = Math.exp(Math.log(a.distance) + (Math.log(b.distance) - Math.log(a.distance)) * e) + Math.sin(Math.PI * e) * f.hop;
    v.azimuth = a.azimuth + (b.azimuth - a.azimuth) * e;
    v.elevation = a.elevation + (b.elevation - a.elevation) * e;
    this.apply();
    if (t >= 1) { this.flight = null; f.resolve(); }
  }
}
