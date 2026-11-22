import { describe, expect, it } from 'vitest';
import { config } from '../../config';
import { createRevealGate, type GateClock } from './index';

function fakeClock() {
  let t = 0;
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  const clock: GateClock = {
    now: () => t,
    setTimer(fn, ms) { const timer = { at: t + ms, fn, live: true }; timers.push(timer); return () => { timer.live = false; }; },
  };
  const advance = (ms: number) => {
    t += ms;
    for (const timer of timers) if (timer.live && timer.at <= t) { timer.live = false; timer.fn(); }
  };
  return { clock, advance };
}

const maxWaitMs = config.reveal.maxWaitSeconds * 1000;
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

describe('reveal gate', () => {
  it('waits for both passes and reveals the full structure', async () => {
    const { clock, advance } = fakeClock();
    const gate = createRevealGate({ maxWaitMs, clock });
    let mode: string | null = null;
    void gate.readyToStructure().then((m) => { mode = m; });
    gate.begin();
    gate.fastPassDone();
    advance(maxWaitMs / 2);
    await settle();
    expect(mode).toBeNull();
    expect(gate.phase).toBe('parsing');
    gate.slowPassDone();
    await settle();
    expect(mode).toBe('full');
    gate.structureReady();
    gate.settled();
    expect(gate.phase).toBe('revealed');
    expect(gate.refinedReady).toBe(false);
    advance(maxWaitMs * 2); // the cancelled timer must not fire
    expect(gate.mode).toBe('full');
  });

  it('fires the escape hatch, then offers the refined structure once the slow pass ends after the reveal', async () => {
    const { clock, advance } = fakeClock();
    const gate = createRevealGate({ maxWaitMs, clock });
    let refined = 0;
    gate.onRefinedReady(() => { refined++; });
    gate.begin();
    gate.fastPassDone();
    advance(maxWaitMs);
    expect(await gate.readyToStructure()).toBe('imports-only');
    gate.structureReady();
    gate.slowPassDone(); // finishes while the layout is settling: nothing is offered before the reveal
    expect(refined).toBe(0);
    gate.settled();
    expect(refined).toBe(1);
    expect(gate.refinedReady).toBe(true);
    gate.refinedApplied();
    expect(gate.refinedReady).toBe(false);
    expect(gate.mode).toBe('full');
  });

  it('does not decide on the timeout alone: the fast pass must finish first', async () => {
    const { clock, advance } = fakeClock();
    const gate = createRevealGate({ maxWaitMs, clock });
    gate.begin();
    advance(maxWaitMs * 3);
    expect(gate.phase).toBe('parsing');
    gate.fastPassDone();
    expect(await gate.readyToStructure()).toBe('imports-only');
  });
});
