// Import resolution for Ruby (PLAN.md §6.4).
//
//   require_relative 'x'   relative to the requiring file; exact.
//   require 'a/b'          against the load-path roots the repo itself holds: any directory named
//                          `lib` (one per gem or app), `spec` and `test`, each `app/*` directory, and
//                          the repo root. Nothing found there means stdlib or a gem: no edge.
//   load, autoload         their literal path, the same way.
//   const                  a constant the file refers to. First the index of constants that files
//                          define (ScanResult.decls), looked up through the file's own namespaces the
//                          way Ruby looks up a constant lexically; then the autoloader's naming
//                          convention (`Admin::UsersController` → a path ending
//                          `admin/users_controller.rb`). Both are inferences, so neither reaches the
//                          confidence of a written require.
import type { FileFacts, ImportSpec, RepoIndex, ResolvedImport, Resolver } from '../../contracts/lang';
import { basename, dirname, joinPath } from '../../shared';

const EXACT = 1;
/** `require` found under several load paths; the one nearest the requiring file is kept. */
const NEAREST_ROOT = 0.8;
/** `require 'a/b'` matched by path suffix under a directory that is not a known load path. */
const OFF_LOAD_PATH = 0.6;
/** A constant some file defines under exactly the referenced name. */
const DEFINED_CONSTANT = 0.9;
/** A constant matched to a file by the naming convention alone. */
const NAMING_CONVENTION = 0.6;
/** Several candidates and nothing but directory distance to choose with. */
const AMBIGUOUS = 0.3;

/** Namespaces of a file tried for one constant reference, innermost first. */
const MAX_SCOPES = 12;

/** `UserMailer` → `user_mailer`, `HTTPClient` → `http_client`: ActiveSupport's `underscore`, without inflection rules. */
export function underscore(name: string): string {
  return name.replace(/([A-Z\d]+)([A-Z][a-z])/g, '$1_$2').replace(/([a-z\d])([A-Z])/g, '$1_$2').toLowerCase();
}

const squash = (name: string): string => name.replace(/_/g, '').toLowerCase();
const lastSegment = (name: string): string => { const at = name.lastIndexOf('::'); return at < 0 ? name : name.slice(at + 2); };

function commonSegments(a: string, b: string): number {
  const x = a.split('/'), y = b.split('/');
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n] && x[n] !== '') n++;
  return n;
}

/** True for a directory Ruby code conventionally has on its load path. */
function isLoadPath(dir: string): boolean {
  if (dir === '') return true;
  const name = basename(dir);
  return name === 'lib' || name === 'spec' || name === 'test' || basename(dirname(dir)) === 'app';
}

export function createRubyResolver(index: RepoIndex): Resolver {
  // Constant → the files that define it. A namespace module is reopened by every file under it.
  const definers = new Map<string, string[]>();
  for (const f of index.byLang('ruby')) {
    for (const key of ['classes', 'constants']) {
      for (const name of f.decls?.[key] ?? []) {
        const list = definers.get(name);
        if (!list) definers.set(name, [f.path]); else if (!list.includes(f.path)) list.push(f.path);
      }
    }
  }

  /** The candidate whose directory shares the most leading segments with `from`; shortest path on a tie. */
  const nearest = (from: string, candidates: readonly string[], dirOf: (p: string) => string = dirname): string => {
    const dir = dirname(from);
    let best = candidates[0], bestScore = -1;
    for (const p of candidates) {
      const score = commonSegments(dir, dirOf(p));
      if (score > bestScore || (score === bestScore && (p.length < best.length || (p.length === best.length && p < best)))) {
        best = p; bestScore = score;
      }
    }
    return best;
  };

  const resolveRelative = (file: FileFacts, spec: string): ResolvedImport[] => {
    const base = joinPath(dirname(file.path), spec);
    if (!base) return [];
    for (const p of [`${base}.rb`, base]) if (p !== file.path && index.has(p)) return [{ path: p, confidence: EXACT }];
    return [];
  };

  const resolveRequire = (file: FileFacts, spec: string): ResolvedImport[] => {
    if (spec.startsWith('/')) return [];
    if (spec.startsWith('./') || spec.startsWith('../')) { // relative to the working directory: the repo root, usually
      const fromRoot = joinPath(spec);
      for (const p of fromRoot ? [`${fromRoot}.rb`, fromRoot] : []) if (p !== file.path && index.has(p)) return [{ path: p, confidence: EXACT }];
      return resolveRelative(file, spec);
    }
    const target = basename(spec).includes('.') ? spec : `${spec}.rb`;
    const rootOf = (p: string): string => (p.length === target.length ? '' : p.slice(0, p.length - target.length - 1));
    const hits = index.bySuffix(target).filter((p) => p !== file.path);
    const onPath = hits.filter((p) => isLoadPath(rootOf(p)));
    if (onPath.length === 1) return [{ path: onPath[0], confidence: EXACT }];
    if (onPath.length > 1) return [{ path: nearest(file.path, onPath, rootOf), confidence: NEAREST_ROOT }];
    // `require 'json'` must not find lib/mygem/json.rb; a longer path that matches is a fair guess.
    if (!target.includes('/') || hits.length === 0) return [];
    return hits.length === 1 ? [{ path: hits[0], confidence: OFF_LOAD_PATH }] : [{ path: nearest(file.path, hits), confidence: AMBIGUOUS }];
  };

  const scopesByFile = new Map<string, string[]>();
  /** Namespaces a constant written in `file` is looked up in, innermost first, ending with the top level. */
  const scopesOf = (file: FileFacts): string[] => {
    let scopes = scopesByFile.get(file.path);
    if (!scopes) {
      const seen = new Set<string>();
      for (const name of file.decls?.classes ?? []) {
        for (let at = name.length; at > 0; at = name.lastIndexOf('::', at - 1)) seen.add(name.slice(0, at));
      }
      scopes = [...seen].sort((a, b) => b.split('::').length - a.split('::').length).slice(0, MAX_SCOPES);
      scopes.push('');
      scopesByFile.set(file.path, scopes);
    }
    return scopes;
  };

  /** One of the files that define `name`: the only one, else the one the naming convention points at. */
  const homeOf = (file: FileFacts, name: string, files: readonly string[]): ResolvedImport[] => {
    if (files.length === 1) return [{ path: files[0], confidence: DEFINED_CONSTANT }];
    const conventional = `${name.split('::').map(underscore).join('/')}.rb`;
    const home = files.filter((p) => p === conventional || p.endsWith(`/${conventional}`));
    if (home.length === 1) return [{ path: home[0], confidence: DEFINED_CONSTANT }];
    return [{ path: nearest(file.path, home.length ? home : files), confidence: AMBIGUOUS }];
  };

  /** False when the scanner saw what `path` defines and nothing there is named like `segment`. */
  const mayDefine = (path: string, segment: string): boolean => {
    const decls = index.get(path)?.decls;
    const names = [...(decls?.classes ?? []), ...(decls?.constants ?? [])];
    return names.length === 0 || names.some((name) => squash(lastSegment(name)) === squash(segment));
  };

  const resolveConstant = (file: FileFacts, spec: string): ResolvedImport[] => {
    const absolute = spec.startsWith('::');
    const segments = (absolute ? spec.slice(2) : spec).split('::');
    if (segments.some((s) => !s)) return [];
    const scopes = absolute ? [''] : scopesOf(file);

    // Defined constants. A miss on `User::ROLES` falls back to `User`, where ROLES is assigned.
    for (let k = segments.length; k > 0; k--) {
      const tail = segments.slice(0, k).join('::');
      for (const scope of scopes) {
        const name = scope ? `${scope}::${tail}` : tail;
        const files = definers.get(name);
        if (!files) continue;
        // This file opens that namespace itself: what it reaches for inside is not known to be elsewhere.
        if (files.includes(file.path) && (k < segments.length || files.length === 1)) return [];
        return homeOf(file, name, files.filter((p) => p !== file.path));
      }
    }

    // Naming convention, for constants no scanned file visibly defines (metaprogramming, skipped files).
    for (let k = segments.length; k > 0; k--) {
      const suffix = `${segments.slice(0, k).map(underscore).join('/')}.rb`;
      const hits = index.bySuffix(suffix).filter((p) => p !== file.path && mayDefine(p, segments[k - 1]));
      if (hits.length === 1) return [{ path: hits[0], confidence: NAMING_CONVENTION }];
      if (hits.length > 1) return [{ path: nearest(file.path, hits), confidence: AMBIGUOUS }];
    }
    return [];
  };

  return {
    resolve(file: FileFacts, imp: ImportSpec): ResolvedImport[] {
      if (!imp.spec) return [];
      switch (imp.kind) {
        case 'require_relative': return resolveRelative(file, imp.spec);
        case 'require': case 'load': case 'autoload': return resolveRequire(file, imp.spec);
        case 'const': return resolveConstant(file, imp.spec);
        default: return [];
      }
    },
  };
}
