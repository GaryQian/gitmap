// Cards: the multi-line chrome element (PLAN.md §17.6). Same material as a pill, 20 px radius.
import type { ComponentProps } from 'react';
import { cx } from './Pill';

export interface CardProps extends ComponentProps<'div'> {
  /** Blur what is behind the card. For the fixed chrome only. */
  blur?: boolean;
}

export function Card({ blur, className, children, ...rest }: CardProps) {
  return <div {...rest} className={cx('gm-card', blur && 'gm-blur', className)}>{children}</div>;
}
