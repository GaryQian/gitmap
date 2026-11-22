// The adaptive-quality controller (PLAN.md §8.5): quality steps down before frame rate does, edge
// count first, then pixel ratio; it steps back up slowly, in the reverse order. Pure: it is fed
// frame timings and answers with the step to use.
//
// A display that keeps up shows every frame one refresh apart however much headroom is left, so
// "comfortably under budget" cannot be read off a frame time. Stepping up is therefore a trial after
// a long good stretch; a trial that has to be undone doubles the wait before the next one.

export interface ControllerTunables {
  slowRatio: number;
  windowMs: number;
  windowFrames: number;
  downShare: number;
  upShare: number;
  settleMs: number;
  upAfterMs: number;
  upAfterMaxMs: number;
  probationMs: number;
  staleMs: number;
}

/** How many steps each lever has. */
export interface Ladder { edgeSteps: number; pixelRatioSteps: number }

export interface FrameTiming {
  /** The frame was drawn for motion, at the full rate (not a reduced-rate frame of a still scene). */
  active: boolean;
  /** Milliseconds since the previous drawn frame; 0 when that is not a measure of this frame's cost. */
  frameMs: number;
  /** The display's frame interval, ms. */
  refreshMs: number;
  /** Timestamp of the frame, ms. */
  nowMs: number;
}

/**
 * The pixel ratios adaptive quality may use, best first: the display's own (capped at `maxDpr`),
 * then each share of it, never below 1, ending at 1. A display at or below 1 has a single entry.
 */
export function pixelRatioLadder(displayRatio: number, maxDpr: number, shares: readonly number[], adaptive: boolean): number[] {
  const base = Math.min(displayRatio > 0 ? displayRatio : 1, maxDpr);
  const out = [base];
  if (!adaptive || base <= 1) return out;
  for (const share of [...shares].sort((a, b) => b - a)) {
    const ratio = Math.max(1, Math.round(base * share * 1000) / 1000);
    if (ratio < out[out.length - 1] - 0.01) out.push(ratio);
  }
  if (out[out.length - 1] > 1) out.push(1);
  return out;
}

export class QualityController {
  /** Edge steps taken (each scales the edge budget), and pixel-ratio steps taken. 0 and 0 is full quality. */
  edgeStep = 0;
  pixelRatioStep = 0;
  private frames = 0;
  private slow = 0;
  private windowMs = 0;
  private goodMs = 0;
  private upAfterMs: number;
  private ignoreUntil = -Infinity;
  private lastSample = -Infinity;
  /** Measured time since the last step up; Infinity when the last step was down or there was none. */
  private sinceUp = Infinity;
  private onTrial = false;

  /** `floorMs`: a frame at or under this is never slow, whatever the display's refresh rate. */
  constructor(private t: ControllerTunables, private ladder: Ladder, private floorMs = 0) {
    this.upAfterMs = t.upAfterMs;
  }

  /** The step reported as RenderStats.quality: 0 = full. */
  get step(): number { return this.edgeStep + this.pixelRatioStep; }

  /** The levers changed (the window moved to a display with another pixel ratio). Steps are kept where they still exist. */
  setLadder(ladder: Ladder): void {
    this.ladder = ladder;
    this.edgeStep = Math.min(this.edgeStep, ladder.edgeSteps);
    this.pixelRatioStep = Math.min(this.pixelRatioStep, ladder.pixelRatioSteps);
  }

  /** Start from a lower point (a large map). Never raises quality. */
  startAt(edgeStep: number, pixelRatioStep: number): void {
    this.edgeStep = Math.max(this.edgeStep, Math.min(edgeStep, this.ladder.edgeSteps));
    this.pixelRatioStep = Math.max(this.pixelRatioStep, Math.min(pixelRatioStep, this.ladder.pixelRatioSteps));
    this.resetWindow();
    this.goodMs = 0;
  }

  /** Something outside the scene's control disturbed frame pacing (a resize, the tab coming back): start measuring afresh. */
  disturb(nowMs: number): void {
    this.resetWindow();
    this.ignoreUntil = Math.max(this.ignoreUntil, nowMs + this.t.settleMs);
  }

  private resetWindow(): void {
    this.frames = this.slow = this.windowMs = 0;
  }

  /** One drawn frame. Returns true when the step changed. */
  frame(f: FrameTiming): boolean {
    const t = this.t;
    // only frames drawn for motion count, and only when the gap to the previous frame is this frame's cost
    if (!f.active || !(f.frameMs > 0) || f.nowMs < this.ignoreUntil) return false;
    if (f.nowMs - this.lastSample > t.staleMs) this.resetWindow();
    this.lastSample = f.nowMs;
    const budget = Math.max(f.refreshMs * t.slowRatio, this.floorMs);
    this.frames++;
    this.windowMs += f.frameMs;
    this.sinceUp += f.frameMs;
    if (f.frameMs > budget) this.slow++;
    if (this.windowMs < t.windowMs || this.frames < t.windowFrames) return false;

    const share = this.slow / this.frames, span = this.windowMs;
    this.resetWindow();
    if (share >= t.downShare) {
      this.goodMs = 0;
      const undo = this.sinceUp < t.probationMs;
      if (!this.stepDown()) return false;
      // the last step up could not be held: wait longer before trying again
      if (undo) this.upAfterMs = Math.min(t.upAfterMaxMs, this.upAfterMs * 2);
      this.sinceUp = Infinity;
      this.onTrial = false;
      this.ignoreUntil = f.nowMs + t.settleMs;
      return true;
    }
    if (share > t.upShare) { this.goodMs = 0; return false; }
    this.goodMs += span;
    if (this.onTrial && this.sinceUp >= t.probationMs) {
      // the last step up held: trials may come sooner again
      this.onTrial = false;
      this.upAfterMs = Math.max(t.upAfterMs, this.upAfterMs / 2);
    }
    if (this.goodMs < this.upAfterMs || !this.stepUp()) return false;
    this.goodMs = 0;
    this.sinceUp = 0;
    this.onTrial = true;
    this.ignoreUntil = f.nowMs + t.settleMs;
    return true;
  }

  /** Edge count first, then pixel ratio. */
  private stepDown(): boolean {
    if (this.edgeStep < this.ladder.edgeSteps) { this.edgeStep++; return true; }
    if (this.pixelRatioStep < this.ladder.pixelRatioSteps) { this.pixelRatioStep++; return true; }
    return false;
  }

  /** The reverse: pixel ratio comes back first, then edges. */
  private stepUp(): boolean {
    if (this.pixelRatioStep > 0) { this.pixelRatioStep--; return true; }
    if (this.edgeStep > 0) { this.edgeStep--; return true; }
    return false;
  }
}
