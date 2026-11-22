// Overlay colours (PLAN.md §10, §17.3). The bright ends are specified per overlay; the faded end
// and the "not yet known" colour derive from the mode's cool dust token, so "old", "not yours" and
// "unknown" recede into the background in both modes.
//
// Everything in this file is a tunable waiting for a key in config.json (see the 4C report).
import type { ThemeMode, ThemeTokens } from '../config';
import type { ColorStop } from '../contracts/render';
import { hexToRgb } from '../shared';

export interface OverlayPalette {
  /** Bright end of the ramp: just modified. */
  recency: string;
  /** Bright end: every commit is the chosen contributor's. */
  ownership: string;
  /** Bright end: one person made every commit. */
  knowledgeRisk: string;
  /** Hot end first: the selection itself, then successive hops. The ramp ends at the faded colour. */
  reach: string[];
  tests: { test: string; covered: string; uncovered: string };
}

/** Bright-end colours per mode: lighter on the dark void, deeper on the light one. */
export const OVERLAY_COLORS: Record<ThemeMode, OverlayPalette> = {
  dark: {
    recency: '#3CF08A',
    ownership: '#B574FF',
    knowledgeRisk: '#FFB02E',
    reach: ['#FFF2B8', '#FFA13D', '#F0503C'],
    tests: { test: '#5BB4FF', covered: '#3C9B78', uncovered: '#FF6A45' },
  },
  light: {
    recency: '#0E9F4E',
    ownership: '#7A2FE0',
    knowledgeRisk: '#D98200',
    reach: ['#C81E3A', '#EE7A1B', '#EDB73C'],
    tests: { test: '#2A7FD9', covered: '#5DAE8E', uncovered: '#E2462B' },
  },
};

export const OVERLAY_RAMP = {
  /** How far "not yet known" sits from cool dust toward the void, 0..1. */
  unknownTowardVoid: 0.4,
  /** Share of the bright colour at the middle of a two-ended ramp. Below 0.5 keeps brightness for the top. */
  midBright: 0.42,
  /**
   * Recency falls off fast: brightness halves every this many seconds of age (exponential decay), so
   * only files changed in the last few weeks read as green and everything older recedes.
   */
  recencyHalfLifeSeconds: 14 * 86400,
  /** Recency: after this many half-lives a file is drawn at the faded end (the legend's low label). */
  recencyFadedAfterHalfLives: 6,
  /** Recency: when the latest change is within this many seconds of the present, the legend says "Now". */
  recencyNowSlackSeconds: 2 * 86400,
  /** Knowledge risk: the ramp starts at this share. Half or less means two people know the file. */
  knowledgeRiskFrom: 0.5,
  /** Reach: the ramp spans at most this many hops; units farther away take the faded end. */
  reachHops: 10,
} as const;

/** Mix two '#rrggbb' colours in sRGB; k = 0 gives a, 1 gives b. */
export function mixHex(a: string, b: string, k: number): string {
  const x = hexToRgb(a), y = hexToRgb(b);
  let out = '#';
  for (let i = 0; i < 3; i++) out += Math.round(255 * (x[i] + (y[i] - x[i]) * k)).toString(16).padStart(2, '0');
  return out;
}

/** The far end of every ramp: the mode's cool dust. */
export function fadedColor(tokens: ThemeTokens): string {
  return tokens.dustCool;
}

/** "Not yet known": dust sunk part of the way into the void, so it sits behind even the faded end. */
export function unknownColor(tokens: ThemeTokens): string {
  return mixHex(tokens.dustCool, tokens.void, OVERLAY_RAMP.unknownTowardVoid);
}

/** Faded at t = 0, bright at t = 1. */
export function fadedToBright(faded: string, bright: string): ColorStop[] {
  return [
    { t: 0, color: faded },
    { t: 0.5, color: mixHex(faded, bright, OVERLAY_RAMP.midBright) },
    { t: 1, color: bright },
  ];
}

/** Hot at t = 0, through the given colours, faded at t = 1. */
export function hotToFaded(hot: readonly string[], faded: string): ColorStop[] {
  const stops = hot.map((color, i) => ({ t: i / hot.length, color }));
  stops.push({ t: 1, color: faded });
  return stops;
}
