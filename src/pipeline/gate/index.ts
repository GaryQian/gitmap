// The reveal gate (PLAN.md §6.8): decides when the map may appear and whether a refinement is
// owed afterwards. A small state machine with an injected clock, so every path can be tested.
//
//   parsing ──fast pass done ∧ (slow pass done ∨ maxWait elapsed)──▶ structuring
//   structuring ──structure ready──▶ settling ──settled──▶ revealed
//
// The decision at the first arrow is the map's structure: 'full' when the slow pass finished in
// time, 'imports-only' when the escape hatch fired. In the second case the slow pass keeps running;
// when it finishes after the reveal, the gate reports that a refined structure is ready, and the
// map stays frozen until the user applies it.

export type GatePhase = 'idle' | 'parsing' | 'structuring' | 'settling' | 'revealed';
export type StructureMode = 'full' | 'imports-only';

export interface GateClock {
  now(): number;
  /** Schedule a callback; returns a cancel function. */
  setTimer(fn: () => void, ms: number): () => void;
}

export const systemClock: GateClock = {
  now: () => Date.now(),
  setTimer(fn, ms) { const t = setTimeout(fn, ms); return () => clearTimeout(t); },
};

export interface RevealGateOptions {
  /** config.reveal.maxWaitSeconds × 1000. 0 or less disables the escape hatch. */
  maxWaitMs: number;
  clock?: GateClock;
}

export interface RevealGate {
  readonly phase: GatePhase;
  /** Set once the gate has decided; null before. */
  readonly mode: StructureMode | null;
  /** True between an imports-only reveal and applyRefined: the slow pass has finished and waits to be applied. */
  readonly refinedReady: boolean;
  /** The parse began: starts the maxWait clock. */
  begin(): void;
  fastPassDone(): void;
  slowPassDone(): void;
  /** Resolves once with the structure mode when analysis may start. */
  readyToStructure(): Promise<StructureMode>;
  structureReady(): void;
  settled(): void;
  /** The refined structure was applied: the model is 'full' and nothing is owed. */
  refinedApplied(): void;
  /** Called (once) when a refined structure becomes ready after an imports-only reveal. */
  onRefinedReady(fn: () => void): void;
  dispose(): void;
}

export function createRevealGate(opts: RevealGateOptions): RevealGate {
  const clock = opts.clock ?? systemClock;
  let phase: GatePhase = 'idle';
  let mode: StructureMode | null = null;
  let fastDone = false, slowDone = false, timedOut = false;
  let refinedReady = false, refinedAnnounced = false;
  let cancelTimer: (() => void) | null = null;
  let resolveReady: ((m: StructureMode) => void) | null = null;
  const ready = new Promise<StructureMode>((r) => { resolveReady = r; });
  const refinedListeners: (() => void)[] = [];

  function decide(): void {
    if (mode !== null || phase !== 'parsing' || !fastDone) return;
    if (!slowDone && !timedOut) return;
    mode = slowDone ? 'full' : 'imports-only';
    phase = 'structuring';
    cancelTimer?.();
    cancelTimer = null;
    resolveReady?.(mode);
  }

  function announceRefined(): void {
    // Only after the reveal: nothing may change on screen before the map is shown, and before the
    // reveal there is no one to offer "Apply" to.
    if (refinedAnnounced || mode !== 'imports-only' || !slowDone || phase !== 'revealed') return;
    refinedAnnounced = true;
    refinedReady = true;
    for (const fn of refinedListeners) fn();
  }

  return {
    get phase() { return phase; },
    get mode() { return mode; },
    get refinedReady() { return refinedReady; },
    begin() {
      if (phase !== 'idle') return;
      phase = 'parsing';
      if (opts.maxWaitMs > 0) cancelTimer = clock.setTimer(() => { timedOut = true; decide(); }, opts.maxWaitMs);
    },
    fastPassDone() { fastDone = true; decide(); },
    slowPassDone() {
      slowDone = true;
      decide();
      announceRefined();
    },
    readyToStructure: () => ready,
    structureReady() { if (phase === 'structuring') phase = 'settling'; },
    settled() {
      if (phase !== 'settling') return;
      phase = 'revealed';
      announceRefined();
    },
    refinedApplied() { refinedReady = false; mode = 'full'; },
    onRefinedReady(fn) { refinedListeners.push(fn); if (refinedReady) fn(); },
    dispose() { cancelTimer?.(); cancelTimer = null; refinedListeners.length = 0; },
  };
}
