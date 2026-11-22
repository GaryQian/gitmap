// Bottom left: the controls key, a short list of the navigation controls shown from the start that
// its pill hides and shows again (remembered in the browser), and beside it the "Reset view" pill (PLAN.md §9, §17.6).
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { AppMount } from '../../contracts/app';
import { isTyping } from '../keys';
import { useRender, useSession } from '../store';
import { APP_LOCAL } from '../tunables';
import { Card, PillButton, cx } from '../ui';
import './controls.css';

/** How to move around, select and open a file; the rest (hover, dragging labels) is found by use. */
const CONTROLS: readonly (readonly [input: string, action: string])[] = [
  ['Drag', 'Pan'],
  ['Wheel', 'Zoom'],
  ['Middle-drag or Space+drag', 'Orbit'],
  ['Shift+click or Shift+drag', 'Select'],
  ['Double-click', 'Open file'],
];

/** The same on a touch screen. */
const TOUCH_CONTROLS: typeof CONTROLS = [
  ['Drag', 'Pan'],
  ['Pinch', 'Zoom'],
  ['Two-finger twist or slide', 'Orbit'],
  ['Tap', 'Select'],
  ['Double-tap', 'Open file'],
];

/** True where the main way of pointing is a finger. */
function useTouchScreen(): boolean {
  const [touch, setTouch] = useState(() => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const query = matchMedia('(pointer: coarse)');
    const onChange = () => setTouch(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return touch;
}

const HIDDEN_KEY = 'starmap.controlsHidden';

function loadHidden(): boolean {
  try { return localStorage.getItem(HIDDEN_KEY) === '1'; } catch { return false; }
}

function ControlsKey() {
  const [open, setOpen] = useState(() => !loadHidden());
  const id = useId();
  const controls = useTouchScreen() ? TOUCH_CONTROLS : CONTROLS;

  const toggle = useCallback(() => {
    setOpen((was) => {
      const next = !was;
      try { localStorage.setItem(HIDDEN_KEY, next ? '0' : '1'); } catch { /* private mode: lasts for this visit */ }
      return next;
    });
  }, []);

  return (
    <div className="gm-controls">
      <PillButton
        blur
        size="small"
        active={open}
        aria-expanded={open}
        aria-controls={id}
        title={open ? 'Hide the controls' : 'Show the controls'}
        onClick={toggle}
      >
        Controls
      </PillButton>
      <Card blur id={id} className={cx('gm-controls-card', open && 'is-open')} role="region" aria-label="Controls" aria-hidden={!open}>
        <dl className="gm-controls-list">
          {controls.map(([input, action]) => (
            <div key={input} className="gm-controls-item">
              <dt>{input}</dt>
              <dd>{action}</dd>
            </div>
          ))}
        </dl>
      </Card>
    </div>
  );
}

function ResetView() {
  const render = useRender();
  const session = useSession();
  const [atDefault, setAtDefault] = useState(true);

  // Asked on the renderer's own events (a rendered frame, the camera starting or stopping), never on a timer.
  useEffect(() => {
    if (!render || !session) return;
    let last = -Infinity;
    const check = () => {
      let home = true;
      try { home = render.isDefaultView() && session.physics.isAtHome(); } catch { /* a stub: nothing to reset */ }
      setAtDefault(home);
    };
    check();
    const offFrame = render.on('frame', (frame) => {
      if (frame.time - last < APP_LOCAL.reset.pollMs) return;
      last = frame.time;
      check();
    });
    const offCamera = render.on('camera', check);
    return () => { offFrame(); offCamera(); };
  }, [render, session]);

  const run = useRef(0);
  const reset = useCallback(() => {
    if (!render || !session) return;
    const mine = ++run.current;
    // the camera and the layout only: selection, overlay and filters are left alone
    const flight = render.resetView().catch(() => {});
    const layout = session.physics.resetLayout().catch((err: unknown) => console.warn('starmap: resetLayout failed', err));
    // The default framing depends on where the cities are, and they were still on their way home
    // when the camera set off. Once both have arrived, fly the last bit if the framing has moved.
    void Promise.all([flight, layout]).then(() => {
      const off = render.on('frame', () => {
        off();
        if (mine === run.current && !render.isDefaultView()) void render.resetView().catch(() => {});
      });
    });
  }, [render, session]);
  useEffect(() => () => { run.current++; }, [render, session]);

  // Home does the same from the keyboard
  const resetRef = useRef(reset);
  resetRef.current = reset;
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // not gated on defaultPrevented: the renderer's own Home handler (camera only) prevents the default first
      if (e.key !== 'Home' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || isTyping(e.target)) return;
      const target = e.target as HTMLElement | null;
      if (target?.tagName === 'INPUT') return; // Home moves a slider to its start
      // ...and goes to the first item of a toolbar, a tab row or a list, or to a splitter's smallest size
      if (target?.closest?.('[role="toolbar"], [role="tablist"], [role="listbox"], [role="separator"]')) return;
      e.preventDefault();
      resetRef.current();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <PillButton
      blur
      size="small"
      className={cx('gm-reset', atDefault && 'is-idle')}
      aria-disabled={atDefault}
      title={atDefault ? 'The view and the layout are already at their defaults' : 'Fly back to the whole map and return every city and district to its place (Home)'}
      onClick={reset}
    >
      Reset view
    </PillButton>
  );
}

const mounts: AppMount[] = [
  { region: 'bottomLeft', order: 0, Component: ControlsKey },
  { region: 'bottomLeft', order: 10, Component: ResetView },
];
export default mounts;
