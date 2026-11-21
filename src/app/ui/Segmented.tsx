// A row of mutually exclusive choices, used in cards (Dark / Light / System). A radio group:
// arrow keys move the choice, Tab enters and leaves the group.
import { useId, useRef, type KeyboardEvent } from 'react';
import { cx } from './Pill';

export interface SegmentedOption<T extends string> { value: T; label: string }

export interface SegmentedProps<T extends string> {
  /** Shown above the row and announced as the group's name. */
  label: string;
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
  className?: string;
}

export function Segmented<T extends string>({ label, value, options, onChange, className }: SegmentedProps<T>) {
  const id = useId();
  const row = useRef<HTMLDivElement>(null);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (step === 0) return;
    e.preventDefault();
    const at = options.findIndex((o) => o.value === value);
    const next = (at + step + options.length) % options.length;
    onChange(options[next]!.value);
    row.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  };

  return (
    <div className={cx('gm-field', className)}>
      <div className="gm-field-label" id={id}>{label}</div>
      <div className="gm-segmented" role="radiogroup" aria-labelledby={id} ref={row} onKeyDown={onKeyDown}>
        {options.map((o) => {
          const checked = o.value === value;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={checked ? 0 : -1}
              className={cx('gm-segment', checked && 'is-active')}
              onClick={() => onChange(o.value)}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
