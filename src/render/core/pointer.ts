// Pointer routing. DOM events on the canvas are offered to handlers in descending priority; the
// camera is the lowest (priority 0). A module takes input over by adding a handler with a higher
// priority and returning true from the hooks it wants to consume (PLAN.md §9; package 2F).
import { RENDER_LOCAL } from './tunables';

export interface PointerInfo {
  /** Canvas-relative CSS pixels. */
  x: number;
  y: number;
  clientX: number;
  clientY: number;
  /** Button that changed (down, up, click); −1 on a plain move. */
  button: number;
  /** Buttons currently held (bit mask, as PointerEvent.buttons). */
  buttons: number;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  meta: boolean;
  /** The Space key is held. */
  space: boolean;
  pointerType: string;
}

export interface WheelInfo extends PointerInfo {
  /** Wheel travel in pixels (line and page modes are converted). */
  deltaY: number;
}

/** Two fingers on the canvas. */
export interface PinchInfo {
  phase: 'start' | 'move' | 'end';
  /** The point midway between the fingers, canvas-relative CSS pixels. */
  x: number;
  y: number;
  /** Distance between the fingers over what it was at the previous event (1 at the start and the end): above 1 they spread. */
  scale: number;
  /** How far the line between the fingers has turned since the previous event, radians, clockwise on screen (0 at the start and the end). */
  turn: number;
  /** The two fingers, canvas-relative CSS pixels. */
  a: { x: number; y: number };
  b: { x: number; y: number };
}

export interface PointerHandler {
  readonly name: string;
  /** Higher runs first. The camera uses 0. */
  readonly priority: number;
  /** A button went down. Return true to capture the gesture: this handler alone then gets move and up. */
  down?(p: PointerInfo): boolean | void;
  /**
   * The pointer moved. During a captured gesture only the capturing handler is called (`captured` is
   * true). Otherwise every handler is offered the move until one returns true.
   */
  move?(p: PointerInfo, captured: boolean): boolean | void;
  /** The captured gesture ended (`cancelled` when the browser took the pointer away). */
  up?(p: PointerInfo, cancelled: boolean): void;
  /** A press and release without a drag. Offered until one handler returns true. */
  click?(p: PointerInfo): boolean | void;
  dblclick?(p: PointerInfo): boolean | void;
  wheel?(w: WheelInfo): boolean | void;
  /**
   * A second finger came down. The start is offered until one handler returns true; that handler
   * then gets every move and the end. A gesture the first finger began is cancelled first (`up`
   * with `cancelled`), and neither finger produces a click.
   */
  pinch?(g: PinchInfo): boolean | void;
  /** The pointer left the canvas. Every handler is told. */
  leave?(): void;
}

export class PointerRouter {
  private handlers: PointerHandler[] = [];
  private capture: { handler: PointerHandler; pointerId: number } | null = null;
  private press: { x: number; y: number; pointerId: number; dragged: boolean } | null = null;
  /** Fingers on the canvas, by pointer id, in canvas-relative CSS pixels. */
  private touches = new Map<number, { x: number; y: number }>();
  private pinch: { a: number; b: number; handler: PointerHandler | null; distance: number; angle: number } | null = null;
  /** Fingers still down after their pinch ended: ignored until they lift, so the one left behind neither pans nor hovers. */
  private spent = new Set<number>();
  private space = false;
  private unlisten: (() => void)[] = [];

  constructor(private canvas: HTMLCanvasElement) {
    const on = <T extends EventTarget, E extends Event>(target: T, type: string, fn: (e: E) => void, opts?: AddEventListenerOptions) => {
      target.addEventListener(type, fn as EventListener, opts);
      this.unlisten.push(() => target.removeEventListener(type, fn as EventListener, opts));
    };
    const previousTouchAction = canvas.style.touchAction;
    canvas.style.touchAction = 'none';
    this.unlisten.push(() => { canvas.style.touchAction = previousTouchAction; });
    on(canvas, 'pointerdown', (e: PointerEvent) => this.onDown(e));
    on(canvas, 'pointermove', (e: PointerEvent) => this.onMove(e));
    on(canvas, 'pointerup', (e: PointerEvent) => this.onUp(e, false));
    on(canvas, 'pointercancel', (e: PointerEvent) => this.onUp(e, true));
    on(canvas, 'pointerleave', () => { if (!this.capture) for (const h of this.handlers) h.leave?.(); });
    on(canvas, 'dblclick', (e: MouseEvent) => { const p = this.info(e, e.button); this.offer((h) => h.dblclick?.(p)); });
    on(canvas, 'wheel', (e: WheelEvent) => this.onWheel(e), { passive: false });
    // the browser's autoscroll on middle click would fight the orbit drag
    on(canvas, 'mousedown', (e: MouseEvent) => { if (e.button === 1) e.preventDefault(); });
    on(window, 'keydown', (e: KeyboardEvent) => { if (e.code === 'Space' && !isTyping(e.target)) this.space = true; });
    on(window, 'keyup', (e: KeyboardEvent) => { if (e.code === 'Space') this.space = false; });
    on(window, 'blur', () => { this.space = false; });
  }

  /** Add a handler. Returns a function that removes it. */
  add(handler: PointerHandler): () => void {
    this.handlers.push(handler);
    this.handlers.sort((a, b) => b.priority - a.priority);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
      if (this.capture?.handler === handler) this.capture = null;
    };
  }

  /** True while a handler holds a captured gesture. */
  get dragging(): boolean { return !!this.capture; }

  private info(e: MouseEvent, button: number): PointerInfo {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left, y: e.clientY - rect.top, clientX: e.clientX, clientY: e.clientY, button, buttons: e.buttons,
      shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey, space: this.space,
      pointerType: (e as PointerEvent).pointerType ?? 'mouse',
    };
  }

  private offer(call: (h: PointerHandler) => boolean | void): PointerHandler | null {
    for (const h of [...this.handlers]) if (call(h) === true) return h;
    return null;
  }

  /** The two pinching fingers: their midpoint, their separation, and the direction from the first to the second. */
  private pinchShape(): { x: number; y: number; distance: number; angle: number; a: { x: number; y: number }; b: { x: number; y: number } } | null {
    const a = this.pinch && this.touches.get(this.pinch.a), b = this.pinch && this.touches.get(this.pinch.b);
    if (!a || !b) return null;
    return {
      x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      angle: Math.atan2(b.y - a.y, b.x - a.x), a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y },
    };
  }

  private startPinch(e: PointerEvent): void {
    // whatever the first finger was doing (a pan, a marquee) ends here, and it is no longer a tap
    if (this.capture) {
      const { handler, pointerId } = this.capture;
      this.capture = null;
      try { this.canvas.releasePointerCapture(pointerId); } catch { /* already released */ }
      handler.up?.(this.info(e, -1), true);
    }
    this.press = null;
    const [a, b] = [...this.touches.keys()];
    this.pinch = { a, b, handler: null, distance: 1, angle: 0 };
    const shape = this.pinchShape()!;
    this.pinch.distance = shape.distance;
    this.pinch.angle = shape.angle;
    this.pinch.handler = this.offer((h) => h.pinch?.({ phase: 'start', x: shape.x, y: shape.y, scale: 1, turn: 0, a: shape.a, b: shape.b }));
    for (const id of [a, b]) { try { this.canvas.setPointerCapture(id); } catch { /* the pointer is already gone */ } }
  }

  private endPinch(): void {
    const pinch = this.pinch;
    if (!pinch) return;
    const shape = this.pinchShape();
    this.pinch = null;
    for (const id of [pinch.a, pinch.b]) if (this.touches.has(id)) this.spent.add(id);
    const at = shape ?? { x: 0, y: 0, a: { x: 0, y: 0 }, b: { x: 0, y: 0 } };
    pinch.handler?.pinch?.({ phase: 'end', x: at.x, y: at.y, scale: 1, turn: 0, a: at.a, b: at.b });
  }

  private onDown(e: PointerEvent): void {
    if (e.pointerType === 'touch') {
      const p = this.info(e, e.button);
      this.touches.set(e.pointerId, { x: p.x, y: p.y });
      if (this.touches.size === 2 && !this.pinch) { this.startPinch(e); return; }
      if (this.touches.size > 1) { this.spent.add(e.pointerId); return; } // a third finger takes no part
    }
    if (this.capture) return; // a second button during a gesture is ignored
    const p = this.info(e, e.button);
    this.press = { x: p.x, y: p.y, pointerId: e.pointerId, dragged: false };
    const handler = this.offer((h) => h.down?.(p));
    if (handler) {
      this.capture = { handler, pointerId: e.pointerId };
      try { this.canvas.setPointerCapture(e.pointerId); } catch { /* the pointer is already gone */ }
    }
  }

  private onMove(e: PointerEvent): void {
    const p = this.info(e, -1);
    const touch = this.touches.get(e.pointerId);
    if (touch) {
      touch.x = p.x; touch.y = p.y;
      const pinch = this.pinch;
      if (pinch && (e.pointerId === pinch.a || e.pointerId === pinch.b)) {
        const shape = this.pinchShape()!;
        const scale = shape.distance / pinch.distance;
        // the short way round, so crossing ±π is not a full turn
        const turn = Math.atan2(Math.sin(shape.angle - pinch.angle), Math.cos(shape.angle - pinch.angle));
        pinch.distance = shape.distance;
        pinch.angle = shape.angle;
        pinch.handler?.pinch?.({ phase: 'move', x: shape.x, y: shape.y, scale, turn, a: shape.a, b: shape.b });
        return;
      }
      if (this.spent.has(e.pointerId)) return;
    }
    const press = this.press;
    if (press && press.pointerId === e.pointerId && !press.dragged
      && Math.hypot(p.x - press.x, p.y - press.y) > RENDER_LOCAL.pointer.clickSlopPx) press.dragged = true;
    if (this.capture) {
      if (this.capture.pointerId === e.pointerId) this.capture.handler.move?.(p, true);
      return;
    }
    this.offer((h) => h.move?.(p, false));
  }

  private onUp(e: PointerEvent, cancelled: boolean): void {
    if (this.touches.has(e.pointerId)) {
      if (this.pinch && (e.pointerId === this.pinch.a || e.pointerId === this.pinch.b)) this.endPinch();
      this.touches.delete(e.pointerId);
      if (this.spent.delete(e.pointerId)) return;
    }
    const p = this.info(e, e.button);
    const press = this.press;
    if (this.capture && this.capture.pointerId === e.pointerId) {
      const { handler } = this.capture;
      this.capture = null;
      try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      handler.up?.(p, cancelled);
    }
    if (press && press.pointerId === e.pointerId) {
      this.press = null;
      if (!cancelled && !press.dragged) this.offer((h) => h.click?.(p));
    }
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.canvas.clientHeight : 1;
    const w: WheelInfo = { ...this.info(e, -1), deltaY: e.deltaY * unit };
    this.offer((h) => h.wheel?.(w));
  }

  dispose(): void {
    for (const off of this.unlisten) off();
    this.unlisten = [];
    this.handlers = [];
    this.capture = null;
    this.pinch = null;
    this.touches.clear();
    this.spent.clear();
  }
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}
