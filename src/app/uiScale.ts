// The chrome's size follows the window: 1 in a maximised browser on a 1080p screen, smaller in a
// smaller window down to a floor that stays legible, and never larger than 1.
//
// The factor is written to `--gm-ui-scale` on the root element. shell.css applies it with CSS `zoom`
// to the fixed chrome, the landing page and the waiting screen, and with the `scale` property to the
// elements anchored in the scene (their positions are written in window pixels by script, so they
// cannot sit inside a zoomed box). The sidebar reader and the chat panel are left at their own size,
// and so is everything on a phone.
import { isPhone, readSignals } from './phone';
import { APP_LOCAL } from './tunables';

let current = 1;
const listeners = new Set<(scale: number) => void>();

/** The scale for a window of this size. */
export function scaleFor(width: number, height: number): number {
  const { refWidth, refHeight, min, max } = APP_LOCAL.uiScale;
  const s = Math.min(width / refWidth, height / refHeight);
  if (!(s > 0)) return 1;
  return Math.round(Math.min(max, Math.max(min, s)) * 1000) / 1000;
}

/** The chrome's current scale. */
export function uiScale(): number { return current; }

/** Called with the new scale whenever it changes. Returns a function that stops. */
export function onUiScale(fn: (scale: number) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function update(): void {
  // a phone has its own folded layout (shell.css), drawn at its written size
  const next = isPhone(readSignals()) ? 1 : scaleFor(window.innerWidth, window.innerHeight);
  if (next === current) return;
  current = next;
  document.documentElement.style.setProperty('--gm-ui-scale', String(next));
  for (const fn of [...listeners]) fn(next);
}

/** Start following the window's size. Called once, before the first render. */
export function initUiScale(): void {
  current = NaN;
  update();
  window.addEventListener('resize', update);
}

/** An element's size on screen, for one drawn at the chrome's scale in the scene (layout sizes are unscaled). */
export function shownSize(el: HTMLElement): { width: number; height: number } {
  return { width: el.offsetWidth * current, height: el.offsetHeight * current };
}
