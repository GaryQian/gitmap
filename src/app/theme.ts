// Theme tokens: config.theme → CSS custom properties on :root (PLAN.md §17.3, §17.6). The renderer
// reads the same config for its shader uniforms, so chrome and scene never drift apart.
import { config, type Config, type ThemeMode } from '../config';
import { hexToRgb } from '../shared';

export type Appearance = 'dark' | 'light' | 'system';
export const APPEARANCES: readonly Appearance[] = ['dark', 'light', 'system'];

type Rgb = [number, number, number];

/** WCAG AA for body text: what "readable on a pill" means in §17.6. */
export const PILL_TEXT_CONTRAST = 4.5;

export function resolveMode(appearance: Appearance, systemDark: boolean): ThemeMode {
  if (appearance === 'system') return systemDark ? 'dark' : 'light';
  return appearance;
}

function linear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance of an sRGB colour with channels in 0..1. */
export function luminance([r, g, b]: Rgb): number {
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** `top` at `alpha` composited over `bottom`. */
export function over(top: Rgb, alpha: number, bottom: Rgb): Rgb {
  return [0, 1, 2].map((i) => top[i]! * alpha + bottom[i]! * (1 - alpha)) as Rgb;
}

/**
 * Smallest opacity at which `surface`, laid over `backdrop`, still gives `text` the target contrast.
 * Returns 1 when even an opaque surface falls short.
 */
export function minOpacityForContrast(text: Rgb, surface: Rgb, backdrop: Rgb, target = PILL_TEXT_CONTRAST): number {
  const at = (alpha: number) => contrastRatio(text, over(surface, alpha, backdrop));
  if (at(0) >= target) return 0;
  if (at(1) < target) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (at(mid) >= target) hi = mid; else lo = mid;
  }
  return Math.ceil(hi * 100) / 100;
}

/**
 * The pill material's base colour: the void in dark mode, white in light mode (§17.6), from
 * config.theme.<mode>.surface.
 */
export function surfaceColor(mode: ThemeMode, theme: Config['theme'] = config.theme): string {
  return theme[mode].surface;
}

/**
 * Pill opacity actually used: config.theme.pill.opacity, raised if needed so text keeps 4.5:1 over
 * the worst backdrop the scene can put behind a pill — something as bright (dark mode) or as dark
 * (light mode) as the text itself.
 */
export function pillOpacity(mode: ThemeMode, theme: Config['theme'] = config.theme): number {
  const text = hexToRgb(theme[mode].text);
  const floor = minOpacityForContrast(text, hexToRgb(surfaceColor(mode, theme)), text);
  return Math.min(1, Math.max(theme.pill.opacity, floor));
}

function rgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex).map((c) => Math.round(c * 255));
  return `rgba(${r}, ${g}, ${b}, ${Number(alpha.toFixed(3))})`;
}

/** Every CSS custom property the chrome uses, for one mode. Documented in src/app/README.md. */
export function themeVariables(mode: ThemeMode, theme: Config['theme'] = config.theme): Record<string, string> {
  const t = theme[mode];
  const surface = surfaceColor(mode, theme);
  const opacity = pillOpacity(mode, theme);
  return {
    '--gm-void': t.void,
    '--gm-dust-cool': t.dustCool,
    '--gm-dust-warm': t.dustWarm,
    '--gm-text': t.text,
    '--gm-halo': t.halo,
    '--gm-warm': t.warm,
    '--gm-sidebar': t.sidebar,
    '--gm-surface': surface,
    '--gm-pill-opacity': String(opacity),
    '--gm-pill-bg': rgba(surface, opacity),
    '--gm-pill-bg-strong': rgba(surface, Math.min(1, opacity + (1 - opacity) * 0.6)),
    '--gm-pill-border-opacity': String(theme.pill.borderOpacity),
    '--gm-hairline': rgba(t.text, theme.pill.borderOpacity),
    '--gm-pill-blur': `${theme.pill.blurPx}px`,
    '--gm-card-radius': `${theme.pill.cardRadiusPx}px`,
    '--gm-wisp-contrast': String(theme.wisps.contrast),
    '--gm-font-ui': `'${theme.fonts.ui} Variable', '${theme.fonts.ui}', system-ui, sans-serif`,
    '--gm-font-code': `'${theme.fonts.code}', ui-monospace, 'Cascadia Mono', Consolas, monospace`,
  };
}

/** Write the mode's tokens to :root. Cheap enough to call on every change; nothing reloads. */
export function applyTheme(mode: ThemeMode): void {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(themeVariables(mode))) root.style.setProperty(name, value);
  root.dataset.theme = mode;
  root.style.colorScheme = mode;
}
