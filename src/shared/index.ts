// Small pure helpers used across modules. Lead-owned.
import type { Config } from '../config';

/** Seeded PRNG (mulberry32). Same seed → same sequence on every engine. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable 32-bit string hash (FNV-1a), for seeds and phases. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/**
 * Sphere radius (PLAN.md §8.1): file size sets it (volume ∝ lines of code) and importance can
 * enlarge it by up to `importanceBoost`, on a curve that keeps the boost for the files that earn it.
 * The one definition shared by physics (collision) and the renderer; nothing else computes a radius.
 */
export function unitRadius(loc: number, importancePct: number, visual: Config['visual']): number {
  const { radiusMin: rMin, radiusMax: rMax, sizeScale: k, importanceBoost, importanceCurve } = visual;
  const rSize = Math.min(rMax, Math.max(rMin, k * Math.cbrt(Math.max(0, loc))));
  const boost = Math.pow(Math.min(1, Math.max(0, importancePct)), importanceCurve);
  return rSize * (1 + importanceBoost * boost);
}

/** Largest radius unitRadius can return, for sizing buffers and spatial hashes. */
export function maxUnitRadius(visual: Config['visual']): number {
  return visual.radiusMax * (1 + visual.importanceBoost);
}

/** Outward glow strength, 0 below config.visual.glowFromPct rising to 1 at the top percentile. */
export function glowAmount(importancePct: number, visual: Config['visual']): number {
  const t = (importancePct - visual.glowFromPct) / (1 - visual.glowFromPct);
  return t <= 0 ? 0 : t >= 1 ? 1 : t;
}

// ---- paths: repo-relative, '/'-separated, no leading slash ----
export function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}
export function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}
/** Lower-case extension without the dot; '' when there is none. */
export function extname(path: string): string {
  const b = basename(path);
  const i = b.lastIndexOf('.');
  return i <= 0 ? '' : b.slice(i + 1).toLowerCase();
}
/** Join and normalise '.', '..' and duplicate slashes. Returns null if the path escapes the root. */
export function joinPath(...parts: string[]): string | null {
  const out: string[] = [];
  for (const part of parts) {
    for (const seg of part.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') { if (out.length === 0) return null; out.pop(); } else out.push(seg);
    }
  }
  return out.join('/');
}

// ---- events ----
export type Handler<T> = (e: T) => void;
export class Emitter<Events extends {}> {
  private handlers = new Map<keyof Events, Set<Handler<any>>>();
  on<E extends keyof Events>(evt: E, fn: Handler<Events[E]>): () => void {
    let set = this.handlers.get(evt);
    if (!set) this.handlers.set(evt, (set = new Set()));
    set.add(fn);
    return () => { set.delete(fn); };
  }
  emit<E extends keyof Events>(evt: E, e: Events[E]): void {
    const set = this.handlers.get(evt);
    if (set) for (const fn of [...set]) fn(e);
  }
  clear(): void { this.handlers.clear(); }
}

// ---- colour ----
/** '#rrggbb' → [r, g, b] in 0..1 (sRGB). */
export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
/** Colour for a language id: config first, then the plug-in's fallback, then the 'other' grey. */
export function languageColor(lang: string, visual: Config['visual'], fallback?: string): string {
  return visual.languageColors[lang] ?? fallback ?? visual.languageColors.other ?? '#8a9099';
}

export const now: () => number = typeof performance !== 'undefined' ? () => performance.now() : () => Date.now();

/** Hex SHA-1 of a git blob with these contents (the blob oid), for verifying fetched content. */
export async function gitBlobOid(bytes: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const buf = new Uint8Array(header.length + bytes.length);
  buf.set(header, 0);
  buf.set(bytes, header.length);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', buf));
  let hex = '';
  for (const b of digest) hex += b.toString(16).padStart(2, '0');
  return hex;
}
