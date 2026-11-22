// Line icons of the chat, drawn like the ones in ../ui: 24-unit box, text colour, the stroke of Jost Regular.
import type { ReactNode } from 'react';

function Icon({ size = 16, children }: { size?: number; children: ReactNode }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"
    >
      {children}
    </svg>
  );
}

/** A speech balloon. */
export function SpeechIcon({ size }: { size?: number }) {
  return (
    <Icon size={size}>
      <path d="M5.5 5h13A2.5 2.5 0 0 1 21 7.5v7a2.5 2.5 0 0 1-2.5 2.5H12l-4.6 3.4V17H5.5A2.5 2.5 0 0 1 3 14.5v-7A2.5 2.5 0 0 1 5.5 5z" />
    </Icon>
  );
}

/** An arrow pointing up: send. */
export function SendIcon({ size }: { size?: number }) {
  return (
    <Icon size={size}>
      <path d="M12 19V5.5M6 11l6-6 6 6" />
    </Icon>
  );
}

/** A square: stop. */
export function StopIcon({ size }: { size?: number }) {
  return (
    <Icon size={size}>
      <rect x="7" y="7" width="10" height="10" rx="1.5" />
    </Icon>
  );
}
