// What two fingers on the map mean (PLAN.md §9). Pure: the pointer router reports the fingers
// (PinchInfo), this decides what the camera should do, and the renderer applies it.
//
// - Both fingers sliding up or down together tilt the view.
// - Anything else is a free gesture: spreading zooms, moving both fingers pans, and twisting them
//   turns the view once the twist has passed a small angle, so that a plain pinch never turns it.
// The choice is made once per gesture, when the fingers have travelled a few pixels.
import type { PinchInfo } from './pointer';
import { RENDER_LOCAL } from './tunables';

export type TwoFingerStep =
  /** Raise or lower the camera: `dy` is the fingers' vertical travel since the previous event, CSS pixels (positive = down). */
  | { kind: 'tilt'; dy: number }
  /** Zoom by `factor` (below 1 = closer), turn the map by `turn` radians (clockwise on screen), and keep the grabbed ground point at (x, y). */
  | { kind: 'free'; x: number; y: number; factor: number; turn: number };

interface Point { x: number; y: number }

export class TwoFingerGesture {
  private mode: 'undecided' | 'tilt' | 'free' = 'undecided';
  private a0: Point;
  private b0: Point;
  private lastY: number;
  /** Twist since the fingers came down, and whether it has passed the threshold. */
  private twisted = 0;
  private turning = false;
  /** Zoom gathered while the gesture was still undecided, applied with the first free step. */
  private pendingScale = 1;

  constructor(start: PinchInfo, private t: typeof RENDER_LOCAL.touch = RENDER_LOCAL.touch) {
    this.a0 = { ...start.a };
    this.b0 = { ...start.b };
    this.lastY = start.y;
  }

  /** The gesture so far: null until the fingers have moved far enough to tell. */
  get kind(): 'tilt' | 'free' | null {
    return this.mode === 'undecided' ? null : this.mode;
  }

  /** A move of the fingers. Returns what the camera should do, or null while it is too early to tell. */
  move(g: PinchInfo): TwoFingerStep | null {
    this.twisted += g.turn;
    if (this.mode === 'undecided') {
      this.pendingScale *= g.scale;
      const da = { x: g.a.x - this.a0.x, y: g.a.y - this.a0.y }, db = { x: g.b.x - this.b0.x, y: g.b.y - this.b0.y };
      if (Math.max(Math.hypot(da.x, da.y), Math.hypot(db.x, db.y)) < this.t.decidePx) return null;
      const vertical = (d: Point) => Math.abs(d.y) >= this.t.decidePx / 2 && Math.abs(d.y) >= this.t.tiltSteepness * Math.abs(d.x);
      this.mode = vertical(da) && vertical(db) && da.y * db.y > 0 ? 'tilt' : 'free';
      this.lastY = g.y;
      if (this.mode === 'tilt') return { kind: 'tilt', dy: 0 };
      const factor = 1 / this.pendingScale;
      this.pendingScale = 1;
      return { kind: 'free', x: g.x, y: g.y, factor, turn: this.turn(g.turn) };
    }
    if (this.mode === 'tilt') {
      const dy = g.y - this.lastY;
      this.lastY = g.y;
      return { kind: 'tilt', dy };
    }
    return { kind: 'free', x: g.x, y: g.y, factor: 1 / g.scale, turn: this.turn(g.turn) };
  }

  /** The part of this event's twist that turns the view: none until the whole twist passes the threshold. */
  private turn(delta: number): number {
    if (this.turning) return delta;
    if (Math.abs(this.twisted) < this.t.twistStartRad) return 0;
    this.turning = true;
    return 0; // the twist that got it here is the dead zone, not a jump
  }
}
