import { describe, expect, it } from 'vitest';
import type { PinchInfo } from './pointer';
import { TwoFingerGesture } from './twoFinger';
import { RENDER_LOCAL } from './tunables';

type P = { x: number; y: number };

/** PinchInfo events for a sequence of finger positions, as the pointer router would report them. */
function events(frames: [P, P][]): PinchInfo[] {
  let prev: [P, P] | null = null;
  return frames.map(([a, b], i) => {
    const dist = Math.hypot(b.x - a.x, b.y - a.y), angle = Math.atan2(b.y - a.y, b.x - a.x);
    const before = prev ?? [a, b];
    const d0 = Math.hypot(before[1].x - before[0].x, before[1].y - before[0].y), a0 = Math.atan2(before[1].y - before[0].y, before[1].x - before[0].x);
    prev = [a, b];
    return { phase: i === 0 ? 'start' : 'move', x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, scale: dist / d0, turn: Math.atan2(Math.sin(angle - a0), Math.cos(angle - a0)), a, b };
  });
}

/** Run a gesture and return every step the camera is given. */
function run(frames: [P, P][]) {
  const [start, ...moves] = events(frames);
  const gesture = new TwoFingerGesture(start);
  return { gesture, steps: moves.map((g) => gesture.move(g)) };
}

/** Two fingers `spread` apart around (cx, cy), the line between them at `angle`. */
const pair = (cx: number, cy: number, spread: number, angle = 0): [P, P] => [
  { x: cx - (Math.cos(angle) * spread) / 2, y: cy - (Math.sin(angle) * spread) / 2 },
  { x: cx + (Math.cos(angle) * spread) / 2, y: cy + (Math.sin(angle) * spread) / 2 },
];

describe('two-finger gesture', () => {
  it('waits for the fingers to move before deciding', () => {
    const { gesture, steps } = run([pair(200, 200, 100), pair(201, 202, 102)]);
    expect(steps).toEqual([null]);
    expect(gesture.kind).toBeNull();
  });

  it('tilts when both fingers slide down or up together', () => {
    const { gesture, steps } = run([pair(200, 200, 100), pair(200, 215, 100), pair(201, 240, 101), pair(200, 220, 100)]);
    expect(gesture.kind).toBe('tilt');
    expect(steps).toEqual([{ kind: 'tilt', dy: 0 }, { kind: 'tilt', dy: 25 }, { kind: 'tilt', dy: -20 }]);
  });

  it('zooms on a pinch without turning the view, and loses none of the spread made before it decided', () => {
    const { gesture, steps } = run([pair(200, 200, 100), pair(200, 200, 110), pair(200, 200, 160, 0.05), pair(200, 200, 200, 0.1)]);
    expect(gesture.kind).toBe('free');
    expect(steps[0]).toBeNull(); // each finger has moved 5 px: too early
    let factor = 1;
    for (const s of steps) {
      if (!s) continue;
      expect(s.kind).toBe('free');
      if (s.kind === 'free') { factor *= s.factor; expect(s.turn).toBe(0); } // 0.1 rad of wobble is under the threshold
    }
    expect(factor).toBeCloseTo(100 / 200, 9);
  });

  it('pans as a free gesture when the fingers move sideways or apart vertically', () => {
    const sideways = run([pair(200, 200, 100), pair(240, 202, 100)]);
    expect(sideways.steps[0]).toMatchObject({ kind: 'free', x: 240, y: 202 });
    // one finger up, one down: a spread along the vertical, not a tilt
    const apart = run([pair(200, 200, 100, Math.PI / 2), pair(200, 200, 160, Math.PI / 2)]);
    expect(apart.gesture.kind).toBe('free');
  });

  it('turns the view once the twist passes the threshold, without a jump', () => {
    const at = RENDER_LOCAL.touch.twistStartRad;
    const { steps } = run([pair(200, 200, 300), pair(200, 200, 300, at * 0.8), pair(200, 200, 300, at * 1.5), pair(200, 200, 300, at * 2.5), pair(200, 200, 300, at * 2)]);
    const turns = steps.map((s) => (s && s.kind === 'free' ? s.turn : null));
    expect(turns[0]).toBe(0);                 // still inside the dead zone
    expect(turns[1]).toBe(0);                 // crossing it engages the turn but does not apply the dead zone
    expect(turns[2]).toBeCloseTo(at, 9);      // from here the view follows the fingers
    expect(turns[3]).toBeCloseTo(-at * 0.5, 9);
  });
});
