// Stage 3 — unit edges: raw file-level edges folded to one edge per ordered unit pair, in
// (src, dst) order. Columns are typed arrays; nothing here allocates per edge.
import type { EdgeKind } from '../model/types';
import { clamp01, type RawEdge } from './resolve';
import type { UnitTable } from './units';

/** Weakest → strongest. An aggregated edge takes the strongest kind among its raw edges. */
export const KIND_STRENGTH: readonly EdgeKind[] = ['import', 'reference', 'call', 'inherit', 'bridge'];
const KIND_RANK: Record<EdgeKind, number> = { import: 0, reference: 1, call: 2, inherit: 3, bridge: 4 };

/** Unit → unit edges as columns, sorted by (src, dst). `src`/`dst` are unit indices into a UnitTable. */
export interface UnitEdges {
  count: number;
  src: Int32Array;
  dst: Int32Array;
  kind: EdgeKind[];
  /** Import statements + log(1 + references) (PLAN.md §6.4). */
  weight: Float64Array;
  /** Maximum over the raw edges. */
  confidence: Float64Array;
  /** Mechanism of a 'bridge' edge, else ''. */
  mechanism: string[];
  /** Top referenced symbols, "name:count|name:count" with the most referenced first; '' when none. */
  symbols: string[];
  /** Per unit: distinct units that depend on it / that it depends on. */
  fanIn: Int32Array;
  fanOut: Int32Array;
}

/** Encoded top symbols ("name:count|name:count") per unit pair, as columns sorted by (src, dst). */
export interface PairSymbols {
  src: number[];
  dst: number[];
  text: string[];
}

/** `symbols` comes from symbol linking (LinkResult.symbols) and must be in (src, dst) order. */
export function aggregateEdges(raw: readonly RawEdge[], units: UnitTable, symbols?: PairSymbols): UnitEdges {
  const n = units.count;
  // Raw edges as unit pairs; edges inside one unit and edges to unknown files drop out.
  let m = 0;
  const rs = new Int32Array(raw.length);
  const rd = new Int32Array(raw.length);
  const ri = new Int32Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const s = units.unitOfFile.get(raw[i].src);
    const d = units.unitOfFile.get(raw[i].dst);
    if (s === undefined || d === undefined || s === d) continue;
    rs[m] = s; rd[m] = d; ri[m] = i; m++;
  }

  // Sort by (src, dst): a stable counting sort on dst, then on src. O(edges + units).
  const byDst = countingSort(n, m, rd, null);
  const order = countingSort(n, m, rs, byDst);

  // Fold runs of equal pairs. Every fold is commutative, so raw-edge order does not matter.
  let count = 0;
  for (let k = 0; k < m; k++) {
    const e = order[k];
    if (k === 0 || rs[e] !== rs[order[k - 1]] || rd[e] !== rd[order[k - 1]]) count++;
  }
  const out: UnitEdges = {
    count,
    src: new Int32Array(count), dst: new Int32Array(count), kind: new Array<EdgeKind>(count),
    weight: new Float64Array(count), confidence: new Float64Array(count),
    mechanism: new Array<string>(count), symbols: new Array<string>(count),
    fanIn: new Int32Array(n), fanOut: new Int32Array(n),
  };
  let a = -1;
  let statements = 0, references = 0, rank = 0, mechanism = '';
  // Edges close in (src, dst) order, the order `symbols` is in: one cursor walks it alongside.
  let p = 0;
  const symbolsOf = (s: number, d: number): string => {
    if (!symbols) return '';
    const { src, dst, text } = symbols;
    while (p < text.length && (src[p] < s || (src[p] === s && dst[p] < d))) p++;
    return p < text.length && src[p] === s && dst[p] === d ? text[p] : '';
  };
  const close = () => {
    if (a < 0) return;
    out.weight[a] = statements + Math.log(1 + references);
    out.kind[a] = KIND_STRENGTH[rank];
    out.mechanism[a] = rank === KIND_RANK.bridge ? mechanism : '';
    out.symbols[a] = symbolsOf(out.src[a], out.dst[a]);
  };
  for (let k = 0; k < m; k++) {
    const e = order[k];
    if (a < 0 || rs[e] !== out.src[a] || rd[e] !== out.dst[a]) {
      close();
      a++;
      out.src[a] = rs[e]; out.dst[a] = rd[e];
      out.fanOut[rs[e]]++; out.fanIn[rd[e]]++;
      statements = 0; references = 0; rank = 0; mechanism = '';
    }
    const r = raw[ri[e]];
    const c = r.count ?? 1;
    // Imports and bridges count once per statement; calls, references and inheritance go under the log.
    if (r.kind === 'import' || r.kind === 'bridge') statements += c; else references += c;
    const conf = clamp01(r.confidence);
    if (conf > out.confidence[a]) out.confidence[a] = conf;
    const kr = KIND_RANK[r.kind] ?? 0;
    if (kr > rank) rank = kr;
    if (r.kind === 'bridge' && r.mechanism && (mechanism === '' || r.mechanism < mechanism)) mechanism = r.mechanism;
  }
  close();
  return out;
}

/** Stable sort of positions 0..m-1 (or of `prev`'s order) by key[position], keys in 0..buckets-1. */
function countingSort(buckets: number, m: number, key: Int32Array, prev: Int32Array | null): Int32Array {
  const start = new Int32Array(buckets + 1);
  for (let k = 0; k < m; k++) start[key[k] + 1]++;
  for (let b = 0; b < buckets; b++) start[b + 1] += start[b];
  const out = new Int32Array(m);
  for (let k = 0; k < m; k++) {
    const e = prev ? prev[k] : k;
    out[start[key[e]]++] = e;
  }
  return out;
}
