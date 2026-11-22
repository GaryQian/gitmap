// The commonest file-type colour of each group of units (a district or a city): what a ribbon end
// and a district aggregate are tinted with. Pure, and linear in the number of units.

/**
 * `group[u]` is the group of unit slot u (−1: none); `color` holds [r, g, b, alive] bytes per unit
 * slot (UnitLookup.color). Returns [r, g, b] in 0..1 per group; a group with no live unit gets
 * `fallback`. Ties go to the colour with the lower RGB value, so the result does not depend on slot order.
 */
export function dominantColors(group: ArrayLike<number>, groups: number, color: ArrayLike<number>, fallback = 0.6): Float32Array {
  const out = new Float32Array(groups * 3).fill(fallback);
  if (groups <= 0) return out;
  // colours come from a small palette (one per language): index them, then tally per group
  const paletteOf = new Map<number, number>();
  const palette: number[] = [];
  const n = Math.min(group.length, Math.floor(color.length / 4));
  const index = new Uint16Array(n);
  for (let u = 0; u < n; u++) {
    const g = group[u];
    if (!(g >= 0) || g >= groups || !color[4 * u + 3]) { index[u] = 0xffff; continue; }
    const key = (color[4 * u] << 16) | (color[4 * u + 1] << 8) | color[4 * u + 2];
    let p = paletteOf.get(key);
    if (p === undefined) { p = palette.length; palette.push(key); paletteOf.set(key, p); }
    index[u] = Math.min(p, 0xfffe);
  }
  const P = Math.min(palette.length, 0xffff);
  if (!P) return out;
  const tally = new Int32Array(groups * P);
  for (let u = 0; u < n; u++) if (index[u] !== 0xffff) tally[group[u] * P + index[u]]++;
  for (let g = 0; g < groups; g++) {
    let best = -1, most = 0;
    for (let p = 0; p < P; p++) {
      const c = tally[g * P + p];
      if (c > most || (c === most && c > 0 && palette[p] < best)) { best = palette[p]; most = c; }
    }
    if (best >= 0) { out[3 * g] = ((best >> 16) & 255) / 255; out[3 * g + 1] = ((best >> 8) & 255) / 255; out[3 * g + 2] = (best & 255) / 255; }
  }
  return out;
}
