// Overlay state for the sphere instances (PLAN.md §3.1, §8.1, §8.6): what each star's overlay
// colour was and is, and the two uniforms that animate between them. Pure: no three.js, no WebGL.
//
//   mix    0 = language colours, 1 = overlay colours. Moves when an overlay is switched on or off.
//   blend  0 = the previous overlay state, 1 = the current one. Restarts on every change while an
//          overlay is showing, so values fade in as history chunks land and a switch from one
//          overlay to another cross-fades. Nothing is animated per instance on the CPU: a change
//          is one upload of `data` (and the small ramp texture) plus these uniforms.
//
// Each instance carries two ramp positions, [from, to], and the ramp texture has two rows to match:
// row 0 is the ramp `from` is read against, row 1 the ramp for `to`. OVERLAY_UNKNOWN (−1) in either
// place means "not yet known" and is drawn in the neutral unlit style.
import type { OverlayView } from '../../contracts/render';
import { hexToRgb } from '../../shared';
import { OVERLAY_UNKNOWN, RAMP_WIDTH, buildRamp, overlayT } from '../spheres/overlay';

/** Floats per instance in `data`: from, to. */
export const OVERLAY_ITEMS = 2;
/**
 * The glow of the brightest stars under an overlay, as a share of the glow the most important file
 * has without one (0..1). Half: clearly lit, without the overlay's colour washing out its neighbours.
 */
export const OVERLAY_GLOW = 0.5;
/** Rows of the ramp texture: from, to. */
export const RAMP_ROWS = 2;
const ROW = RAMP_WIDTH * 4;

export class OverlayFade {
  /** Per instance [from, to]; the `aOverlay` attribute. Reallocated by resize(). */
  data = new Float32Array(0);
  /** RGBA bytes, RAMP_WIDTH × RAMP_ROWS. */
  readonly ramp = new Uint8Array(ROW * RAMP_ROWS);
  /** "Not yet known" colour for the from and to states, sRGB 0..1. */
  unknownFrom: [number, number, number] = [0.5, 0.5, 0.5];
  unknown: [number, number, number] = [0.5, 0.5, 0.5];
  mix = 0;
  blend = 1;
  /** Set when `data` or `ramp` changed and must be uploaded; the owner clears them. */
  dataDirty = false;
  rampDirty = false;

  private target = 0;
  /** How strongly the strong end of the current overlay's ramp glows: OVERLAY_GLOW, or 0 when it adds none (OverlayView.glow). Kept while fading out. */
  glow = 0;
  /** The view whose values are in the `to` column. */
  private view: OverlayView | null = null;
  /** An update of the same overlay that arrived mid-fade; applied when the fade ends. */
  private queued: OverlayView | null = null;
  private capacity = 0;

  /** `instant`: reduced motion, no fades at all. */
  constructor(private readonly fadeMs: number, private readonly instant = false) {}

  /** True while an overlay is on screen, including one that is fading out. */
  get showing(): boolean { return this.mix > 0 || this.target > 0; }

  resize(capacity: number): void {
    if (capacity === this.capacity) return;
    const data = new Float32Array(capacity * OVERLAY_ITEMS).fill(OVERLAY_UNKNOWN);
    data.set(this.data.subarray(0, Math.min(this.data.length, data.length)));
    this.data = data;
    this.capacity = capacity;
    this.dataDirty = true;
  }

  /**
   * RenderApi.setOverlay. `live[slot]` is non-zero for slots that hold a unit. A new view while an
   * overlay is showing cross-fades from what is drawn now; `null` fades back to language colours
   * and leaves the overlay's values in place while it does.
   */
  set(view: OverlayView | null, live: ArrayLike<number>): void {
    this.queued = null;
    if (!view) {
      this.view = null;
      this.target = 0;
      if (this.instant) this.mix = 0;
      return;
    }
    const crossfade = this.showing && !this.instant;
    // Updates of one overlay can land faster than a fade (history chunks). Restarting the fade
    // each time would make the values still fading jump, so the newest update waits for the fade.
    if (crossfade && this.blend < 1 && this.view?.id === view.id) { this.queued = view; this.target = 1; return; }
    this.apply(view, live, crossfade);
  }

  private apply(view: OverlayView, live: ArrayLike<number>, crossfade: boolean): void {
    const { data, ramp } = this;
    if (crossfade) {
      // what is on screen becomes the state to fade from
      for (let i = 0; i < data.length; i += OVERLAY_ITEMS) data[i] = data[i + 1];
      ramp.copyWithin(0, ROW, ROW * 2);
      this.unknownFrom = this.unknown;
      this.blend = 0;
    }
    ramp.set(buildRamp(view.stops, view.discrete, RAMP_WIDTH), ROW);
    this.unknown = hexToRgb(view.unknown);
    this.glow = (view.glow ?? !view.discrete) ? OVERLAY_GLOW : 0;
    this.view = view;
    for (let s = 0; s < this.capacity; s++) data[s * OVERLAY_ITEMS + 1] = this.valueOf(s, live[s] > 0);
    if (!crossfade) {
      for (let i = 0; i < data.length; i += OVERLAY_ITEMS) data[i] = data[i + 1];
      ramp.copyWithin(0, ROW, ROW * 2);
      this.unknownFrom = this.unknown;
      this.blend = 1;
    }
    this.target = 1;
    if (this.instant) this.mix = 1;
    this.dataDirty = this.rampDirty = true;
  }

  private valueOf(slot: number, alive: boolean): number {
    const v = this.view;
    return v && alive ? overlayT(slot < v.values.length ? v.values[slot] : undefined, v.domain) : OVERLAY_UNKNOWN;
  }

  /** A unit appeared in or left a slot: it takes the current value at once (it grows in anyway). */
  writeSlot(slot: number, alive: boolean): void {
    if (slot < 0 || slot >= this.capacity) return;
    const t = this.valueOf(slot, alive);
    this.data[slot * OVERLAY_ITEMS] = this.data[slot * OVERLAY_ITEMS + 1] = t;
    this.dataDirty = true;
  }

  /** Slots were renumbered (a rebuild): re-read every value, without a fade. */
  rewrite(live: ArrayLike<number>): void {
    for (let s = 0; s < this.capacity; s++) this.writeSlot(s, live[s] > 0);
    this.dataDirty = true;
  }

  /** Advance the fades by `dtMs`. Returns true while something is still moving. */
  step(dtMs: number, live: ArrayLike<number>): boolean {
    const step = this.instant || !(this.fadeMs > 0) ? 1 : Math.max(0, dtMs) / this.fadeMs;
    let moving = false;
    if (this.mix !== this.target) {
      this.mix = this.target > this.mix ? Math.min(this.target, this.mix + step) : Math.max(this.target, this.mix - step);
      moving = true;
    }
    if (this.blend < 1) {
      this.blend = Math.min(1, this.blend + step);
      moving = true;
    }
    if (this.blend >= 1 && this.queued) {
      const next = this.queued;
      this.queued = null;
      this.apply(next, live, !this.instant);
      moving = true;
    }
    return moving;
  }
}
