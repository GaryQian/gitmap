// Header pairing (PLAN.md §6.4) as a UnitMapper: a C / C++ / Objective-C header and its
// implementation become one unit whose primary file is the implementation.
//
// Two files can pair when they have the same basename without extension, one extension from each
// list below, and sit in the same directory or in mirrored `include/` ↔ `src/` trees. A header pairs
// with at most one implementation and the other way round; among several possible pairs the one
// where the implementation includes the header wins, then the same-directory one, then path order.
import { basename, dirname, extname } from '../../shared';
import { comparePaths } from '../order';
import type { UnitMapper } from '../units';

export const HEADER_EXTENSIONS: readonly string[] = ['h', 'hh', 'hpp', 'hxx'];
export const IMPLEMENTATION_EXTENSIONS: readonly string[] = ['c', 'cc', 'cpp', 'cxx', 'm', 'mm'];
/** Directory names that mirror each other: `lib/include/a/x.h` pairs with `lib/src/a/x.c`. */
const MIRRORED_DIRS: readonly string[] = ['include', 'src'];

const HEADER = 1, IMPLEMENTATION = 2;

/** The directory with every mirrored segment replaced by one placeholder, so mirrored trees compare equal. */
function mirrorKey(dir: string): string {
  if (!dir) return '';
  const segs = dir.split('/');
  for (let i = 0; i < segs.length; i++) if (MIRRORED_DIRS.includes(segs[i])) segs[i] = '\u0000';
  return segs.join('/');
}

export const pairHeaders: UnitMapper = (files, rawEdges) => {
  const n = files.length;
  const out = new Array<string>(n);
  const role = new Uint8Array(n);
  // Candidate groups: files that could pair with each other, by (mirrored directory, basename).
  const groups = new Map<string, { headers: number[]; impls: number[] }>();
  for (let i = 0; i < n; i++) {
    const path = files[i].path;
    out[i] = path;
    const ext = extname(path);
    if (!ext) continue;
    const r = HEADER_EXTENSIONS.includes(ext) ? HEADER : IMPLEMENTATION_EXTENSIONS.includes(ext) ? IMPLEMENTATION : 0;
    if (!r) continue;
    role[i] = r;
    const base = basename(path);
    const key = mirrorKey(dirname(path)) + '/' + base.slice(0, base.length - ext.length - 1);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { headers: [], impls: [] }));
    (r === HEADER ? g.headers : g.impls).push(i);
  }
  let any = false;
  for (const g of groups.values()) if (g.headers.length && g.impls.length) { any = true; break; }
  if (!any) return out;

  // Which implementation includes which header (file index pairs, as impl * n + header).
  const fileIndex = new Map<string, number>();
  for (let i = 0; i < n; i++) if (role[i]) fileIndex.set(files[i].path, i);
  const includes = new Set<number>();
  for (const e of rawEdges) {
    if (e.kind !== 'import') continue;
    const s = fileIndex.get(e.src);
    const d = fileIndex.get(e.dst);
    if (s !== undefined && d !== undefined && role[s] === IMPLEMENTATION && role[d] === HEADER) includes.add(s * n + d);
  }

  for (const g of groups.values()) {
    if (!g.headers.length || !g.impls.length) continue;
    // Every possible pair of the group, best first; then take greedily.
    const cands: { h: number; i: number; inc: number; same: number }[] = [];
    for (const h of g.headers) {
      const hDir = dirname(files[h].path);
      for (const i of g.impls) {
        cands.push({ h, i, inc: includes.has(i * n + h) ? 1 : 0, same: dirname(files[i].path) === hDir ? 1 : 0 });
      }
    }
    cands.sort((a, b) => b.inc - a.inc || b.same - a.same
      || comparePaths(files[a.i].path, files[b.i].path) || comparePaths(files[a.h].path, files[b.h].path));
    const taken = new Set<number>();
    for (const c of cands) {
      if (taken.has(c.h) || taken.has(c.i)) continue;
      taken.add(c.h);
      taken.add(c.i);
      out[c.h] = files[c.i].path;
    }
  }
  return out;
};
