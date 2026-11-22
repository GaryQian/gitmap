// Bottom left: the controls key, one tiny pill that opens into the list of controls on hover or
// focus, and beside it the "Reset view" pill (PLAN.md §9, §17.6).
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { AppMount } from '../../contracts/app';
import { isTyping } from '../keys';
import { useRender, useSession } from '../store';
import { APP_LOCAL } from '../tunables';
import { Card, PillButton, cx } from '../ui';
import './controls.css';

/** The table in PLAN.md §9, in the order a newcomer needs it. */
const CONTROLS: readonly (readonly [input: string, action: string])[] = [
  ['Drag', 'Pan'],
  ['Middle-drag or Space+drag', 'Orbit'],
  ['Wheel', 'Zoom toward the pointer'],
  ['Hover', 'Show a file and its connections'],
  ['Click', 'Select a file'],
  ['Shift+click', 'Add to or remove from the selection'],
  ['Shift+drag', 'Select an area'],
  ['Double-click', 'Open the file'],
  ['Drag a label', 'Move a city or district'],
  ['Escape', 'Clear the selection'],
  ['Home', 'Reset view'],
];

function ControlsKey() {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const id = useId();
  const open = (hovered || focused) && !dismissed;

  return (
    <div
      className="gm-controls"
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => { setHovered(false); setDismissed(false); }}
      onFocus={() => setFocused(true)}
      onBlur={() => { setFocused(false); setDismissed(false); }}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || !open) return;
        e.stopPropagation(); // this Escape closes the list; the selection stays
        setDismissed(true);
      }}
    >
      <PillButton blur size="small" active={open} aria-expanded={open} aria-controls={id} onClick={() => setDismissed(false)}>
        Controls
      </PillButton>
      <Card blur id={id} className={cx('gm-controls-card', open && 'is-open')} role="region" aria-label="Controls" aria-hidden={!open}>
        <dl className="gm-controls-list">
          {CONTROLS.map(([input, action]) => (
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
    const layout = session.physics.resetLayout().catch((err: unknown) => console.warn('gitmap: resetLayout failed', err));
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
      if ((e.target as HTMLElement | null)?.tagName === 'INPUT') return; // Home moves a slider to its start
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
  { region: 'bottomLeft', order: 0, Componen