// Seeded order: every list the digest shows is shuffled with config.clustering.seed, so position
// never hints at rank, and the same model always gives the same text.
import { hash32, mulberry32 } from '../../shared';

/** An independent stream per use, so a change in one list never reorders another. */
export function rngFor(seed: number, salt: string): () => number {
  return mulberry32(hash32(`${seed}:${salt}`));
}

/** Fisher–Yates, in place. */
export function shuffle<T>(items: T[], rnd: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = items[i];
    items[i] = items[j];
    items[j] = t;
  }
  return items;
}

/** ranks[i] is the shuffled position of item i. */
export function shuffledRanks(n: number, rnd: () => number): Int32Array {
  const order = shuffle(Array.from({ length: n }, (_, i) => i), rnd);
  const ranks = new Int32Array(n);
  for (let pos = 0; pos < n; pos++) ranks[order[pos]] = pos;
  return ranks;
}

/** Code-unit order: the same on every engine and locale, unlike localeCompare. */
export function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Collapse to one line and cap the length. */
export function oneLine(text: string, max: number): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}
