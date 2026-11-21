// Pills: the single-line chrome element (PLAN.md §17.6). Fully rounded, translucent, hairline border.
import type { ComponentProps, ReactNode } from 'react';

export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(' ');
}

interface PillLook {
  /** Blur what is behind the pill. For the fixed chrome only (about ten elements), never in-scene pills. */
  blur?: boolean;
  /** Selected or open: more opaque, with a halo ring. */
  active?: boolean;
  size?: 'small' | 'medium' | 'large';
}

function pillClass({ blur, active, size = 'medium' }: PillLook, extra?: string, more?: string): string {
  return cx('gm-pill', `gm-pill-${size}`, blur && 'gm-blur', active && 'is-active', more, extra);
}

export interface PillProps extends ComponentProps<'div'>, PillLook {}

/** A pill that holds text, and optionally PillSegment buttons and a ProgressLine. */
export function Pill({ blur, active, size, className, children, ...rest }: PillProps) {
  return <div {...rest} className={pillClass({ blur, active, size }, className)}>{children}</div>;
}

export interface PillButtonProps extends ComponentProps<'button'>, PillLook {
  /** A circle holding one icon. Give it an aria-label. */
  round?: boolean;
}

/** A pill that is one button. */
export function PillButton({ blur, active, size, round, className, children, type = 'button', ...rest }: PillButtonProps) {
  return (
    <button {...rest} type={type} className={pillClass({ blur, active, size }, className, cx('gm-pill-button', round && 'gm-pill-round'))}>
      {children}
    </button>
  );
}

/** A button segment inside a Pill: the "Apply" in "Refined structure ready · Apply". Put it last. */
export function PillSegment({ className, children, type = 'button', ...rest }: ComponentProps<'button'>) {
  return <button {...rest} type={type} className={cx('gm-pill-segment', className)}>{children}</button>;
}

/** Emphasis inside a pill (repo names, counts): Jost Medium. */
export function Strong({ children }: { children: ReactNode }) {
  return <span className="gm-strong">{children}</span>;
}

/**
 * The thin progress line along a pill's lower edge. `value` is 0..1; null or undefined draws nothing.
 * Place it as the last child of a Pill.
 */
export function ProgressLine({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const v = Math.min(1, Math.max(0, value));
  return <span className="gm-line" aria-hidden="true"><span style={{ transform: `scaleX(${v})` }} /></span>;
}
