// Include resolution shared by the C-family plug-ins (PLAN.md §6.4). C, C++ and Objective-C share
// one header namespace, so one resolver serves them all.
//
// A quoted include is looked up next to the including file first. Otherwise, and always for an
// angle include, the path is matched as a suffix against every file in the repo; several matches
// are settled by the nearest directory (longest common path prefix with the including file). When
// that cannot settle it, one best match is returned with lower confidence, never several edges.
import type { FileFacts, ImportSpec, RepoIndex, ResolvedImport, Resolver } from '../../contracts/lang';
import { dirname, joinPath } from '../../shared';

/**
 * Confidence by how the target was found, for: a quoted include, an angle include with a directory
 * part (`<lib/x.h>`), and an angle include of a bare name (`<math.h>`). A bare angle name is usually a
 * system header, so a repo file that happens to share the name is a weak guess.
 */
const CONFIDENCE = {
  /** Found relative to the including file. */
  relative: [1, 1, 1],
  /** The include path is the file's whole repo path. */
  rootPath: [1, 0.8, 0.4],
  /** The only file in the repo with that suffix. */
  unique: [0.9, 0.7, 0.4],
  /** Several candidates, one of them nearest. */
  nearest: [0.8, 0.6, 0.4],
  /** Several candidates and no nearest one. */
  ambiguous: [0.5, 0.4, 0.3],
} as const;

function commonSegments(a: string, b: string): number {
  if (!a || !b) return 0;
  const x = a.split('/'), y = b.split('/');
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n++;
  return n;
}

/** The include path as a suffix to match: '/'-separated, without './' and leading '../' segments. */
function suffixOf(spec: string): string {
  const out: string[] = [];
  for (const seg of spec.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  return out.join('/');
}

function createIncludeResolver(index: RepoIndex): Resolver {
  return {
    resolve(file: FileFacts, imp: ImportSpec): ResolvedImport[] {
      const spec = imp.spec.trim().replace(/\\/g, '/');
      const quoted = imp.kind !== 'include-system';
      const col = quoted ? 0 : spec.includes('/') ? 1 : 2;
      const dir = dirname(file.path);
      if (quoted) {
        const p = joinPath(dir, spec);
        if (p && p !== file.path && index.has(p)) return [{ path: p, confidence: CONFIDENCE.relative[col] }];
      }
      const suffix = suffixOf(spec);
      if (!suffix) return [];
      const candidates = index.bySuffix(suffix).filter((p) => p !== file.path);
      if (candidates.length === 0) return [];
      if (candidates.length === 1) {
        const kind = candidates[0] === suffix ? 'rootPath' : 'unique';
        return [{ path: candidates[0], confidence: CONFIDENCE[kind][col] }];
      }
      let best: string[] = [], bestScore = -1;
      for (const p of candidates) {
        const score = commonSegments(dir, dirname(p));
        if (score > bestScore) { best = [p]; bestScore = score; } else if (score === bestScore) best.push(p);
      }
      if (best.length === 1) return [{ path: best[0], confidence: CONFIDENCE.nearest[col] }];
      // No nearest one: prefer the repo-root path, then the shortest, then alphabetical, and say so in the confidence.
      best.sort((a, b) => Number(b === suffix) - Number(a === suffix) || a.length - b.length || (a < b ? -1 : 1));
      return [{ path: best[0], confidence: CONFIDENCE.ambiguous[col] }];
    },
  };
}

const resolvers = new WeakMap<RepoIndex, Resolver>();
/** The include resolver for an index; one instance serves every C-family plug-in. */
export function includeResolver(index: RepoIndex): Resolver {
  let r = resolvers.get(index);
  if (!r) resolvers.set(index, (r = createIncludeResolver(index)));
  return r;
}
