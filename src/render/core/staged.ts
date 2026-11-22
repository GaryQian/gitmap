// Work spread over animation frames. A job is a generator that yields wherever it may be paused; the
// caller pumps it for a few milliseconds per frame and commits the result only when it is done, so
// nothing half-built is ever drawn. Pure: no DOM, no WebGL.

/** A pausable job. Each `yield` is a point where it may stop until the next frame. */
export type Steps = Generator<void, void, void>;

/**
 * Advance a job until it ends or `budgetMs` has been used. It always takes at least one step, so a
 * job finishes even when single steps overrun the budget. Returns true when the job is done.
 */
export function pump(job: Steps, budgetMs: number, now: () => number = () => performance.now()): boolean {
  const start = now();
  for (;;) {
    if (job.next().done) return true;
    if (now() - start >= budgetMs) return false;
  }
}

/** Run a job to its end in one go. */
export function drain(job: Steps): void {
  while (!job.next().done) { /* keep going */ }
}

/**
 * The display's frame interval, measured as the shortest recent gap between animation frames: a busy
 * frame arrives late, never early. Clamped to plausible displays (30–240 Hz), so a renderer that
 * never manages a frame in time is still held to a real display's budget.
 */
export class RefreshEstimator {
  private ring: Float32Array;
  private at = 0;
  private filled = 0;
  private best = Infinity;

  constructor(private fallbackMs = 1000 / 60, window = 120, private minMs = 1000 / 240, private maxMs = 1000 / 30) {
    this.ring = new Float32Array(Math.max(1, window));
  }

  /** One gap between consecutive animation frames, ms. */
  add(deltaMs: number): void {
    if (!(deltaMs > 0) || deltaMs > 1000) return;
    const evicted = this.filled === this.ring.length ? this.ring[this.at] : Infinity;
    this.ring[this.at] = deltaMs;
    this.at = (this.at + 1) % this.ring.length;
    if (this.filled < this.ring.length) this.filled++;
    if (deltaMs <= this.best) this.best = deltaMs;
    else if (evicted <= this.best) {
      let best = Infinity;
      for (let i = 0; i < this.filled; i++) if (this.ring[i] < best) best = this.ring[i];
      this.best = best;
    }
  }

  /** Forget what was measured (the tab was hidden, the window moved to another display). */
  reset(): void {
    this.at = this.filled = 0;
    this.best = Infinity;
  }

  get ms(): number {
    if (!this.filled) return this.fallbackMs;
    return Math.min(this.maxMs, Math.max(this.minMs, this.best));
  }
}
