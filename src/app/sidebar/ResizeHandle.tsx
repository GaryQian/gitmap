// The reader's left edge, as a handle: drag it, or focus it and use the arrow keys. A window
// splitter in ARIA terms (role="separator" with a value), whose value is the reader's width.
import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { cx } from '../ui';
import { SIDEBAR_LOCAL as T } from './tunables';

export interface ResizeHandleProps {
  width: number;
  min: number;
  max: number;
  /** `done` is false while a drag is moving and true for its last value, and for every key press. */
  onResize: (width: number, done: boolean) => void;
  /** Double-click: back to the default width. */
  onReset: () => void;
}

export function ResizeHandle({ width, min, max, onResize, onReset }: ResizeHandleProps) {
  const drag = useRef<{ x: number; width: number; last: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, width, last: width };
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    // the handle is the reader's left edge, so moving left makes the reader wider
    d.last = d.width + (d.x - e.clientX);
    onResize(d.last, false);
  };
  const end = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    setDragging(false);
    onResize(d.last, true);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? T.keyStepLargePx : T.keyStepPx;
    const next =
      e.key === 'ArrowLeft' ? width + step
      : e.key === 'ArrowRight' ? width - step
      : e.key === 'Home' ? min
      : e.key === 'End' ? max
      : null;
    if (next === null) return;
    e.preventDefault();
    onResize(next, true);
  };

  return (
    <div
      className={cx('gm-reader-resize', dragging && 'is-dragging')}
      role="separator"
      aria-orientation="vertical"
      aria-label="Reader width"
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuetext={`${width} pixels`}
      tabIndex={0}
      title="Drag to resize"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
    />
  );
}
