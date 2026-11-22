import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PointerRouter, type PinchInfo, type PointerHandler } from './pointer';

/** A canvas as far as the router needs one: an event target at (10, 20) on the page. */
function fakeCanvas(): HTMLCanvasElement {
  const target = new EventTarget();
  return Object.assign(target, {
    style: { touchAction: '' },
    clientHeight: 600,
    getBoundingClientRect: () => ({ left: 10, top: 20 }),
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
  }) as unknown as HTMLCanvasElement;
}

function send(canvas: HTMLCanvasElement, type: string, pointerId: number, x: number, y: number, pointerType = 'touch'): void {
  const e = Object.assign(new Event(type), { pointerId, pointerType, clientX: x + 10, clientY: y + 20, button: type === 'pointermove' ? -1 : 0, buttons: 1 });
  canvas.dispatchEvent(e);
}

/** A camera-like handler that records what it is told. */
function recorder() {
  const log: string[] = [];
  const pinches: PinchInfo[] = [];
  const handler: PointerHandler = {
    name: 'test', priority: 0,
    down(p) { log.push(`down ${p.x},${p.y}`); return true; },
    move(p, captured) { log.push(`${captured ? 'drag' : 'hover'} ${p.x},${p.y}`); },
    up(_p, cancelled) { log.push(cancelled ? 'cancel' : 'up'); },
    click() { log.push('click'); },
    pinch(g) { pinches.push(g); log.push(`pinch ${g.phase}`); return true; },
  };
  return { log, pinches, handler };
}

describe('pointer router: two fingers', () => {
  let canvas: HTMLCanvasElement;
  let router: PointerRouter;
  beforeEach(() => {
    vi.stubGlobal('window', new EventTarget());
    canvas = fakeCanvas();
    router = new PointerRouter(canvas);
  });
  afterEach(() => { router.dispose(); vi.unstubAllGlobals(); });

  it('turns a second finger into a pinch, cancelling the first finger\'s drag', () => {
    const { log, pinches, handler } = recorder();
    router.add(handler);
    send(canvas, 'pointerdown', 1, 100, 100);
    send(canvas, 'pointermove', 1, 120, 100);
    send(canvas, 'pointerdown', 2, 220, 100);
    expect(log).toEqual(['down 100,100', 'drag 120,100', 'cancel', 'pinch start']);
    expect(pinches[0]).toEqual({ phase: 'start', x: 170, y: 100, scale: 1, turn: 0, a: { x: 120, y: 100 }, b: { x: 220, y: 100 } });
    expect(router.dragging).toBe(false);

    // the fingers spread from 100 apart to 200, then both move down
    send(canvas, 'pointermove', 2, 320, 100);
    expect(pinches[1]).toEqual({ phase: 'move', x: 220, y: 100, scale: 2, turn: 0, a: { x: 120, y: 100 }, b: { x: 320, y: 100 } });
    send(canvas, 'pointermove', 1, 120, 160);
    send(canvas, 'pointermove', 2, 320, 160);
    expect(pinches[3].scale).toBeCloseTo(200 / Math.hypot(200, 60), 9);
    expect(pinches[3]).toMatchObject({ phase: 'move', x: 220, y: 160 });
    // each scale is relative to the event before it, so their product is the whole change
    expect(pinches.reduce((s, g) => s * g.scale, 1)).toBeCloseTo(2, 9);
    // the first finger dropping below the second turned the line between them anticlockwise on screen, and back
    expect(pinches[2].turn).toBeCloseTo(-Math.atan2(60, 200), 9);
    expect(pinches[3].turn).toBeCloseTo(Math.atan2(60, 200), 9);
  });

  it('reports a twist the short way round', () => {
    const { pinches, handler } = recorder();
    router.add(handler);
    // the second finger is to the left of the first: the line between them points at ±π
    send(canvas, 'pointerdown', 1, 300, 200);
    send(canvas, 'pointerdown', 2, 100, 199);
    send(canvas, 'pointermove', 2, 100, 201);
    expect(Math.abs(pinches[1].turn)).toBeCloseTo(2 * Math.atan2(1, 200), 9);
    expect(pinches[1].turn).toBeLessThan(0);
  });

  it('ends the pinch when one finger lifts, and ignores the finger left behind', () => {
    const { log, handler } = recorder();
    router.add(handler);
    send(canvas, 'pointerdown', 1, 100, 100);
    send(canvas, 'pointerdown', 2, 200, 100);
    log.length = 0;
    send(canvas, 'pointerup', 2, 200, 100);
    send(canvas, 'pointermove', 1, 400, 300);
    send(canvas, 'pointerup', 1, 400, 300);
    expect(log).toEqual(['pinch end']); // no pan, no hover, no click

    // afterwards one finger is an ordinary press again, and a tap is a click
    send(canvas, 'pointerdown', 3, 50, 50);
    send(canvas, 'pointerup', 3, 50, 50);
    expect(log.slice(1)).toEqual(['down 50,50', 'up', 'click']);
  });

  it('leaves a third finger out, and a mouse never pinches', () => {
    const { log, pinches, handler } = recorder();
    router.add(handler);
    send(canvas, 'pointerdown', 1, 100, 100);
    send(canvas, 'pointerdown', 2, 200, 100);
    send(canvas, 'pointerdown', 3, 300, 300);
    send(canvas, 'pointermove', 3, 500, 500);
    send(canvas, 'pointerup', 3, 500, 500);
    expect(pinches.map((g) => g.phase)).toEqual(['start']);
    send(canvas, 'pointercancel', 1, 100, 100);
    send(canvas, 'pointerup', 2, 200, 100);
    expect(pinches.map((g) => g.phase)).toEqual(['start', 'end']);

    log.length = 0;
    send(canvas, 'pointerdown', 7, 10, 10, 'mouse');
    send(canvas, 'pointerdown', 8, 90, 10, 'mouse');
    expect(log).toEqual(['down 10,10']);
  });

  it('does not let a pinch that nobody takes reach the other hooks', () => {
    const log: string[] = [];
    router.add({ name: 'plain', priority: 0, down() { log.push('down'); return true; }, move() { log.push('move'); }, up(_p, c) { log.push(c ? 'cancel' : 'up'); }, click() { log.push('click'); } });
    send(canvas, 'pointerdown', 1, 100, 100);
    send(canvas, 'pointerdown', 2, 200, 100);
    send(canvas, 'pointermove', 2, 300, 100);
    send(canvas, 'pointerup', 2, 300, 100);
    send(canvas, 'pointerup', 1, 100, 100);
    expect(log).toEqual(['down', 'cancel']);
  });
});
