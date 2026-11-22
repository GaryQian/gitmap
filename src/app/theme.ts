// Theme tokens: config.theme → CSS custom properties on :root (PLAN.md §17.3, §17.6). The renderer
// reads the same config for its shader uniforms, so chrome and scene never drift apart.
import { config, type Config, type ThemeMode } from '../config';
import { hexToRgb } from '../shared';

type Rgb = [number, number, number];

/** WCAG AA for body text: what "readable on a pill" means in §17.6. */
export const PILL_TEXT_CONTRAST = 4.5;
/** WCAG AA for large text, and for what is not text: focus rings, essential icons, the parts of a control. */
export const GRAPHIC_CONTRAST = 3;

/** Secondary text ("dim"): this much text colour, the rest the surface colour. Opaque, so it holds over any backdrop. */
const DIM_TEXT_MIX = 0.72;
/** The quietest text in the sidebar (comments, line numbers): at least this much text colour, more where 4.5:1 needs it. */
const QUIET_TEXT_MIX = 0.56;
/** Hover, active and the anchored cards are this share of the way from the pill's opacity to opaque. */
const STRONG_STEP = 0.6;
/** The fill behind a selected segment or legend row: the text colour at this opacity (ui.css, legend.css). */
const SELECTED_FILL = 0.14;

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
 * Smallest opacity from which `surface`, laid over `backdrop`, gives `text` the target contrast all
 * the way up to opaque. Returns 1 when even an opaque surface falls short.
 */
export function minOpacityForContrast(text: Rgb, surface: Rgb, backdrop: Rgb, target = PILL_TEXT_CONTRAST): number {
  const at = (alpha: number) => contrastRatio(text, over(surface, alpha, backdrop));
  let percent = 100;
  while (percent > 0 && at((percent - 1) / 100) >= target) percent--;
  return percent / 100;
}

/**
 * The pill material's base colour: the void in dark mode, white in light mode (§17.6), from
 * config.theme.<mode>.surface.
 */
export function surfaceColor(mode: ThemeMode, theme: Config['theme'] = config.theme): string {
  return theme[mode].surface;
}

/**
 * The worst thing the scene can put behind a translucent element: white in dark mode (the core of
 * a bright star is additive light and saturates), black in light mode (nothing there is darker).
 */
export function worstBackdrop(mode: ThemeMode): Rgb {
  return mode === 'dark' ? [1, 1, 1] : [0, 0, 0];
}

interface Palette { text: Rgb; dim: Rgb; surface: Rgb; sidebar: Rgb; halo: Rgb; backdrop: Rgb }

function palette(mode: ThemeMode, theme: Config['theme']): Palette {
  const t = theme[mode];
  const text = hexToRgb(t.text);
  const surface = hexToRgb(surfaceColor(mode, theme));
  return { text, surface, dim: over(text, DIM_TEXT_MIX, surface), sidebar: hexToRgb(t.sidebar), halo: hexToRgb(t.halo), backdrop: worstBackdrop(mode) };
}

/**
 * Pill opacity actually used: config.theme.pill.opacity, raised if needed so that over the worst
 * backdrop text on a pill keeps 4.5:1 and a dim icon on it (a close button) keeps 3:1. Dim text does
 * not belong on a bare pill: it needs the card's opacity.
 */
export function pillOpacity(mode: ThemeMode, theme: Config['theme'] = config.theme): number {
  const c = palette(mode, theme);
  return Math.min(1, Math.max(
    theme.pill.opacity,
    minOpacityForContrast(c.text, c.surface, c.backdrop),
    minOpacityForContrast(c.dim, c.surface, c.backdrop, GRAPHIC_CONTRAST),
  ));
}

/** Card opacity: cards hold secondary text, so the least at which dim text keeps 4.5:1 over the worst backdrop. */
export function cardOpacity(mode: ThemeMode, theme: Config['theme'] = config.theme): number {
  const c = palette(mode, theme);
  return Math.max(pillOpacity(mode, theme), minOpacityForContrast(c.dim, c.surface, c.backdrop));
}

/** The more opaque material: a hovered or active pill, the cards anchored in the scene, district pills. Never less than a card. */
export function strongOpacity(mode: ThemeMode, theme: Config['theme'] = config.theme): number {
  const pill = pillOpacity(mode, theme);
  return Math.max(Math.min(1, pill + (1 - pill) * STRONG_STEP), cardOpacity(mode, theme));
}

/** `from` moved toward `to` a hundredth at a time until `ok`; `to` itself if it never is. */
function mixUntil(from: Rgb, to: Rgb, ok: (color: Rgb) => boolean): Rgb {
  for (let percent = 0; percent < 100; percent++) {
    const color = over(to, percent / 100, from);
    if (ok(color)) return color;
  }
  return to;
}

/**
 * The halo colour as text (a link, the action of an action pill): the halo itself where that reads
 * at 4.5:1 on a card over the worst backdrop, otherwise moved toward the text colour until it does.
 * Link text sits on the card material or something more opaque, never on a bare pill.
 */
export function linkColor(mode: ThemeMode, theme: Config['theme'] = config.theme): Rgb {
  const c = palette(mode, theme);
  const card = over(c.surface, cardOpacity(mode, theme), c.backdrop);
  return mixUntil(c.halo, c.text, (color) => contrastRatio(color, card) >= PILL_TEXT_CONTRAST);
}

/** The quietest text on the opaque sidebar (comments, line numbers), kept at 4.5:1. */
export function quietTextColor(mode: ThemeMode, theme: Config['theme'] = config.theme): Rgb {
  const c = palette(mode, theme);
  return mixUntil(over(c.text, QUIET_TEXT_MIX, c.sidebar), c.text, (color) => contrastRatio(color, c.sidebar) >= PILL_TEXT_CONTRAST);
}

/** An in-scene pill of material opacity `material`, faded as a whole to `fade`, over the worst backdrop. */
function fadedContrast(c: Palette, color: Rgb, material: number, fade: number): number {
  return contrastRatio(over(color, fade, c.backdrop), over(over(c.surface, material, c.backdrop), fade, c.backdrop));
}

/**
 * How far an in-scene pill may fade with distance (pills/layer.ts fades the whole element): the
 * least opacity at which a district's name (on the strong material) and a city's name and count (on
 * the opaque surface) all keep 4.5:1 over the worst backdrop.
 */
export function sceneFadeFloor(mode: ThemeMode, theme: Config['theme'] = config.theme): number {
  const c = palette(mode, theme);
  const strong = strongOpacity(mode, theme);
  const holds = (fade: number): boolean =>
    fadedContrast(c, c.text, strong, fade) >= PILL_TEXT_CONTRAST && fadedContrast(c, c.dim, 1, fade) >= PILL_TEXT_CONTRAST;
  let percent = 100;
  while (percent > 0 && holds((percent - 1) / 100)) percent--;
  return percent / 100;
}

export interface ContrastCheck { what: string; ratio: number; min: number }

/**
 * Every pairing of foreground and material the chrome uses, measured over the worst backdrop, with
 * the ratio it must reach. theme.test.ts asserts the whole list for both modes.
 */
export function contrastChecks(mode: ThemeMode, theme: Config['theme'] = config.theme): ContrastCheck[] {
  const c = palette(mode, theme);
  const on = (opacity: number): Rgb => over(c.surface, opacity, c.backdrop);
  const pill = on(pillOpacity(mode, theme));
  const card = on(cardOpacity(mode, theme));
  const strongAt = strongOpacity(mode, theme);
  const strong = on(strongAt);
  const link = linkColor(mode, theme);
  const fade = sceneFadeFloor(mode, theme);
  const body = PILL_TEXT_CONTRAST;
  const check = (what: string, fg: Rgb, bg: Rgb, min: number): ContrastCheck => ({ what, ratio: contrastRatio(fg, bg), min });
  return [
    check('text on a pill', c.text, pill, body),
    check('dim icon on a pill', c.dim, pill, GRAPHIC_CONTRAST),
    check('text on a card', c.text, card, body),
    check('dim text on a card (labels, counts, placeholders, dimmed legend rows)', c.dim, card, body),
    check('link text on a card', link, card, body),
    check('text on a selected segment or legend row', c.text, over(c.text, SELECTED_FILL, card), body),
    check('dim text on the strong material (tooltip, detail card, open search field)', c.dim, strong, body),
    check('link text on the strong material', link, strong, body),
    check('focus ring on its band of surface colour', c.halo, c.surface, GRAPHIC_CONTRAST),
    check('focus ring and halo marks inside a card', c.halo, card, GRAPHIC_CONTRAST),
    { what: 'district pill name at the far fade', ratio: fadedContrast(c, c.text, strongAt, fade), min: body },
    { what: 'city pill name at the far fade', ratio: fadedContrast(c, c.text, 1, fade), min: body },
    { what: 'city pill count at the far fade', ratio: fadedContrast(c, c.dim, 1, fade), min: body },
    check('text on the sidebar', c.text, c.sidebar, body),
    check('dim text on the sidebar', c.dim, c.sidebar, body),
    check('quiet text on the sidebar (comments, line numbers)', quietTextColor(mode, theme), c.sidebar, body),
    check('link text on the sidebar', link, c.sidebar, body),
    check('focus ring on the sidebar', c.halo, c.sidebar, GRAPHIC_CONTRAST),
  ];
}

function rgba(color: string | Rgb, alpha = 1): string {
  const [r, g, b] = (typeof color === 'string' ? hexToRgb(color) : color).map((c) => Math.round(c * 255));
  return alpha >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${Number(alpha.toFixed(3))})`;
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
    '--gm-text-dim': rgba(palette(mode, theme).dim),
    '--gm-text-quiet': rgba(quietTextColor(mode, theme)),
    '--gm-halo': t.halo,
    '--gm-link': rgba(linkColor(mode, theme)),
    '--gm-warm': t.warm,
    '--gm-sidebar': t.sidebar,
    '--gm-surface': surface,
    '--gm-pill-opacity': String(opacity),
    '--gm-pill-bg': rgba(surface, opacity),
    '--gm-pill-bg-strong': rgba(surface, strongOpacity(mode, theme)),
    '--gm-card-bg': rgba(surface, cardOpacity(mode, theme)),
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
