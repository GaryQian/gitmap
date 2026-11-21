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
  /** The pointer left the canvas. Every handler is told. */
  leave?(): void;
}

export class PointerRouter {
  private handlers: PointerHandler[] = [];
  private capture: { handler: PointerHandler; pointerId: number } | null = null;
  private press: { x: number; y: number; pointerId: number; dragged: boolean } | null = null;
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

  private onDown(e: PointerEvent): void {
    if (this.capture) return; // a second button or finger during a gesture is ignored
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
  }
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}
