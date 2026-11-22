// Territory tints: one hue per city, a small shift per district. Pure. Shared by the territory pass
// (fills and contours) and by the edge ribbons, so a ribbon has the colour of the ground it leaves.
import { TERRITORY_LOCAL } from './tunables';

export type Rgb = [number, number, number];

function hslToRgb(h: number, s: number, l: number): Rgb {
  const k = (n: number) => (n + h * 12) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}

const frac = (x: number) => x - Math.floor(x);
/** A stable 0..1 value per slot. */
const slotNoise = (slot: number) => (Math.imul(slot + 1, 0x9e3779b1) >>> 0) / 4294967296;

/** Tint of a city, sRGB 0..1. Successive slots step by the golden ratio, so neighbours in slot order differ. */
export function cityTint(citySlot: number, t: typeof TERRITORY_LOCAL.tint = TERRITORY_LOCAL.tint): Rgb {
  return hslToRgb(frac(t.hueStart + Math.max(0, citySlot) * 0.61803398875), t.saturation, t.lightness);
}

/** Tint of a district: its city's hue, nudged in hue and lightness so neighbouring districts can be told apart. */
export function districtTint(districtSlot: number, citySlot: number, t: typeof TERRITORY_LOCAL.tint = TERRITORY_LOCAL.tint): Rgb {
  const n = slotNoise(districtSlot), m = slotNoise(districtSlot * 7 + 3);
  const hue = frac(t.hueStart + Math.max(0, citySlot) * 0.61803398875 + (n - 0.5) * 2 * t.districtHue + 1);
  return hslToRgb(hue, t.saturation, t.lightness + (m - 0.5) * 2 * t.districtLightness);
}
