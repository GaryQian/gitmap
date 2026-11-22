// Line icons, drawn in the text colour. 16 px by default; stroke width matches Jost Regular's stems.
import type { SVGAttributes } from 'react';

function Icon({ children, size = 16, ...rest }: SVGAttributes<SVGSVGElement> & { size?: number }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest}
    >
      {children}
    </svg>
  );
}

/** Outline of a gear with `teeth` teeth, centred on (12, 12). */
function gearPath(teeth: number, outer: number, inner: number): string {
  const step = (Math.PI * 2) / teeth;
  const points: string[] = [];
  for (let i = 0; i < teeth; i++) {
    const a = i * step;
    // each tooth: up the flank, across the top, down the flank, along the root to the next tooth
    for (const [radius, offset] of [[inner, -0.3], [outer, -0.17], [outer, 0.17], [inner, 0.3]] as const) {
      const angle = a + offset * step;
      points.push(`${(12 + radius * Math.sin(angle)).toFixed(2)} ${(12 - radius * Math.cos(angle)).toFixed(2)}`);
    }
  }
  return `M${points.join('L')}Z`;
}
const GEAR = gearPath(8, 9.6, 7.1);

export function GearIcon(props: { size?: number }) {
  return (
    <Icon {...props}>
      <path d={GEAR} />
      <circle cx="12" cy="12" r="2.9" />
    </Icon>
  );
}

/** A lowercase "i" in a circle: what this is. */
export function InfoIcon(props: { size?: number }) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5" />
      <path d="M12 7.6v.01" strokeWidth={2.2} />
    </Icon>
  );
}

export function CloseIcon(props: { size?: number }) {
  return (
    <Icon {...props}>
      <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
    </Icon>
  );
}

/** A window with a panel on its right: shows the sidebar. */
export function PanelIcon(props: { size?: number }) {
  return (
    <Icon {...props}>
      <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
      <path d="M14.5 5v14" />
    </Icon>
  );
}

export function ChevronLeftIcon(props: { size?: number }) {
  return (
    <Icon {...props}>
      <path d="M14.5 6.5L9 12l5.5 5.5" />
    </Icon>
  );
}
