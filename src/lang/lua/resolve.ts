// Import resolution for Lua and Luau (PLAN.md §6.4). One resolver serves both plug-ins, so a
// `.luau` file requiring a `.lua` module (and the other way round) resolves directly.
//
// A module `a/b` is the file a/b.luau, a/b.lua, a/b/init.luau or a/b/init.lua.
//
//   require "a.b.c"            package.path style. From the repo root: exact. Else under a root the
//                              requiring file sits in, or a conventional one (src, lua, lib, …), else
//                              by path suffix anywhere, which is a guess. A one-segment name is only
//                              looked for under such roots: `require "json"` must not find
//                              vendor/x/json.lua.
//   require "./x", "../x"      Luau: relative to the requiring file (for an init file, to its folder
//                              first, then to the folder's parent, which is where newer Luau looks).
//   require "@self/x"          the requiring file's folder.
//   require "@alias/x"         through the `aliases` of the nearest .luaurc above the file.
//   dofile / loadfile          the literal path from the repo root, then beside the file.
//   require(script.Parent.X)   Roblox: `script` is the file (the folder, for an init file), `Parent`
//                              one level up, any other segment a child. Exact, since a Rojo project
//                              maps folders to instances one to one.
//   require(Shared.Util)       an instance path from a service or a variable: the longest tail of it
//                              that is the end of some module's path. A guess.
import type { FileFacts, ImportSpec, RepoIndex, ResolvedImport, Resolver } from '../../contracts/lang';
import { basename, dirname, joinPath } from '../../shared';
import { parseJsonc } from '../ts';

const EXACT = 1;
/** A package.path-style require found under a root that holds the requiring file, or a conventional one. */
const ON_PATH = 0.9;
/** The same, found under several such roots; the nearest is kept. */
const NEAREST_ROOT = 0.8;
/** Matched by path suffix alone. */
const BY_SUFFIX = 0.6;
/** An instance path whose last name alone matched a module. */
const BY_NAME = 0.5;
/** Several candidates and nothing but directory distance to choose with. */
const AMBIGUOUS = 0.3;

export const LUAURC = '.luaurc';
const MODULE_ENDINGS = ['.luau', '.lua', '/init.luau', '/init.lua'];
/** Folders that are conventionally on package.path. */
const LOAD_ROOTS = new Set(['src', 'lua', 'lib', 'libs', 'scripts', 'modules', 'lualib', 'source']);
const SOURCE_EXTENSION = /\.luau?$/;
/** `init.lua`, `init.server.luau`: the script that stands for its folder. */
const INIT_FILE = /^init(?:\.(?:server|client))?\.luau?$/;
/** `Foo.luau`, `Foo.server.lua` → `Foo`: the instance name Rojo gives a script. */
const SCRIPT_SUFFIX = /(?:\.(?:server|client))?\.luau?$/;

function commonSegments(a: string, b: string): number {
  const x = a.split('/'), y = b.split('/');
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n] && x[n] !== '') n++;
  return n;
}

function createLuaResolver(index: RepoIndex): Resolver {
  /** The files a module path (no extension) can be, the requiring file left out. */
  const modulesAt = (base: string | null, self: string): string[] => {
    if (!base) return [];
    const out: string[] = [];
    for (const ending of MODULE_ENDINGS) {
      const p = base + ending;
      if (p !== self && index.has(p)) out.push(p);
    }
    return out;
  };
  /** Modules whose path ends with `tail` (no extension), each with the root it would be loaded from. */
  const modulesEnding = (tail: string, self: string): { path: string; root: string }[] => {
    const out: { path: string; root: string }[] = [];
    for (const ending of MODULE_ENDINGS) {
      const suffix = tail + ending;
      for (const p of index.bySuffix(suffix)) {
        if (p !== self) out.push({ path: p, root: p.length === suffix.length ? '' : p.slice(0, p.length - suffix.length - 1) });
      }
    }
    return out;
  };
  /** The candidate whose directory shares the most leading segments with `from`; shortest path on a tie. */
  const nearest = (from: string, candidates: readonly string[]): string => {
    const dir = dirname(from);
    let best = candidates[0], bestScore = -1;
    for (const p of candidates) {
      const score = commonSegments(dir, dirname(p));
      if (score > bestScore || (score === bestScore && (p.length < best.length || (p.length === best.length && p < best)))) {
        best = p; bestScore = score;
      }
    }
    return best;
  };
  const first = (paths: readonly string[], confidence: number): ResolvedImport[] => (paths.length ? [{ path: paths[0], confidence }] : []);
  const guess = (file: FileFacts, paths: readonly string[], confidence: number): ResolvedImport[] =>
    paths.length === 0 ? [] : paths.length === 1 ? [{ path: paths[0], confidence }] : [{ path: nearest(file.path, paths), confidence: AMBIGUOUS }];

  const resolveRelative = (file: FileFacts, spec: string): ResolvedImport[] => {
    const dir = dirname(file.path);
    const bases = [joinPath(dir, spec)];
    if (INIT_FILE.test(basename(file.path)) && dir) bases.push(joinPath(dirname(dir), spec));
    for (const base of bases) {
      const hits = modulesAt(base, file.path);
      if (hits.length) return first(hits, EXACT);
    }
    return [];
  };

  const aliasesByDir = new Map<string, Record<string, string> | null>();
  const aliasesIn = (dir: string): Record<string, string> | null => {
    let found = aliasesByDir.get(dir);
    if (found === undefined) {
      found = null;
      const text = index.text(dir ? `${dir}/${LUAURC}` : LUAURC);
      const parsed = text ? parseJsonc(text) as { aliases?: unknown } | undefined : undefined;
      if (parsed && typeof parsed === 'object' && parsed.aliases && typeof parsed.aliases === 'object') {
        found = {};
        for (const [name, target] of Object.entries(parsed.aliases)) if (typeof target === 'string') found[name.toLowerCase()] = target;
      }
      aliasesByDir.set(dir, found);
    }
    return found;
  };

  const resolveAlias = (file: FileFacts, spec: string): ResolvedImport[] => {
    const slash = spec.indexOf('/');
    const alias = (slash < 0 ? spec.slice(1) : spec.slice(1, slash)).toLowerCase();
    const rest = slash < 0 ? '' : spec.slice(slash + 1);
    const dir = dirname(file.path);
    if (alias === 'self') return first(modulesAt(joinPath(dir, rest), file.path), EXACT);
    for (let d = dir; ; d = dirname(d)) {
      const target = aliasesIn(d)?.[alias];
      if (target !== undefined) {
        if (/^(?:[A-Za-z]:|\/|~)/.test(target)) return []; // outside the repo
        return first(modulesAt(joinPath(d, target, rest), file.path), EXACT);
      }
      if (!d) break;
    }
    // No .luaurc in sight (a tool-specific config, a package manager): what follows the alias is still a path.
    return rest ? guess(file, modulesEnding(rest, file.path).map((h) => h.path), BY_SUFFIX) : [];
  };

  const resolveModule = (file: FileFacts, raw: string): ResolvedImport[] => {
    const spec = raw.replace(/\\/g, '/').replace(SOURCE_EXTENSION, '');
    if (spec.startsWith('./') || spec.startsWith('../')) return resolveRelative(file, spec);
    if (spec.startsWith('@')) return resolveAlias(file, spec);
    if (spec.startsWith('/') || spec.startsWith('.')) return [];
    const rel = spec.includes('/') ? joinPath(spec) : spec.replace(/\./g, '/');
    if (!rel || rel.includes('//')) return [];

    const atRoot = modulesAt(rel, file.path);
    if (atRoot.length) return first(atRoot, EXACT);
    const hits = modulesEnding(rel, file.path);
    if (hits.length === 0) return [];
    const onPath = hits.filter((h) => file.path.startsWith(`${h.root}/`) || LOAD_ROOTS.has(basename(h.root))).map((h) => h.path);
    if (onPath.length === 1) return [{ path: onPath[0], confidence: ON_PATH }];
    if (onPath.length > 1) return [{ path: nearest(file.path, onPath), confidence: NEAREST_ROOT }];
    return rel.includes('/') ? guess(file, hits.map((h) => h.path), BY_SUFFIX) : [];
  };

  const resolveFile = (file: FileFacts, spec: string): ResolvedImport[] => {
    const path = spec.replace(/\\/g, '/');
    if (path.startsWith('/')) return [];
    for (const p of [joinPath(path), joinPath(dirname(file.path), path)]) {
      if (p && p !== file.path && index.has(p)) return [{ path: p, confidence: EXACT }];
    }
    return [];
  };

  const resolveInstance = (file: FileFacts, spec: string): ResolvedImport[] => {
    const segments = spec.split('.');
    if (segments.some((s) => !s || s.includes('/'))) return [];
    if (segments[0] === 'script') {
      const name = basename(file.path);
      const dir = dirname(file.path);
      let at = INIT_FILE.test(name) ? dir : joinPath(dir, name.replace(SCRIPT_SUFFIX, '')) ?? '';
      for (let k = 1; k < segments.length; k++) {
        if (segments[k] !== 'Parent') at = at ? `${at}/${segments[k]}` : segments[k];
        else if (at) at = dirname(at);
        else return []; // above the repo root
      }
      return first(modulesAt(at, file.path), EXACT);
    }
    if (segments.includes('Parent')) return [];
    // `game.ReplicatedStorage.Shared.Util`, `Packages.Roact`: where the leading names live is the
    // project file's business; the longest tail that is the end of a module's path is the guess.
    for (let start = 0; start < segments.length; start++) {
      const hits = modulesEnding(segments.slice(start).join('/'), file.path).map((h) => h.path);
      if (hits.length) return guess(file, hits, start < segments.length - 1 ? BY_SUFFIX : BY_NAME);
    }
    return [];
  };

  return {
    resolve(file: FileFacts, imp: ImportSpec): ResolvedImport[] {
      if (!imp.spec) return [];
      switch (imp.kind) {
        case 'require': return resolveModule(file, imp.spec);
        case 'file': return resolveFile(file, imp.spec);
        case 'instance': return resolveInstance(file, imp.spec);
        default: return [];
      }
    },
  };
}

const resolvers = new WeakMap<RepoIndex, Resolver>();
/** The Lua resolver for an index; one instance serves the Lua and Luau plug-ins. */
export function luaResolver(index: RepoIndex): Resolver {
  let r = resolvers.get(index);
  if (!r) resolvers.set(index, (r = createLuaResolver(index)));
  return r;
}
