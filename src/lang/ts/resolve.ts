// Import resolution for TypeScript and JavaScript (PLAN.md §6.4): relative paths with extension and
// index probing, tsconfig `paths` / `baseUrl`, workspace package names and package.json `imports`.
// TS and JS share one namespace, so both plug-ins use the same resolver.
import type { FileFacts, ImportSpec, RepoIndex, ResolvedImport, Resolver } from '../../contracts/lang';
import { dirname, joinPath } from '../../shared';
import { parseJsonc } from './jsonc';

/** Extensions tried, in order, when a specifier has none. */
const PROBE_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.d.ts'];
/** A JS extension written for a TS source file (`./x.js` for `./x.ts`). */
const JS_TO_TS: [string, string[]][] = [['.js', ['.ts', '.tsx', '.d.ts']], ['.jsx', ['.tsx']], ['.mjs', ['.mts', '.d.mts']], ['.cjs', ['.cts', '.d.cts']]];
/** Output folders a package.json entry may point into; the source usually sits under `src/` instead. */
const BUILD_DIRS = new Set(['dist', 'lib', 'build', 'out', 'esm', 'cjs', 'es']);
/** package.json export conditions, most source-like first. */
const CONDITIONS = ['source', 'development', 'import', 'module', 'default', 'require', 'types', 'browser', 'node'];
const CONFIG_NAMES = ['tsconfig.json', 'jsconfig.json'];
const MAX_EXTENDS = 8;

const EXACT = 1;
/** A package entry that points at build output, mapped back to a source file by convention. */
const GUESSED_SOURCE = 0.9;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

interface PathRule { prefix: string; suffix: string; star: boolean; targets: string[] }
/** The part of a tsconfig that affects resolution, with directories made repo-relative. */
interface TsConfig { baseUrl: string | null; rules: PathRule[] | null; pathsDir: string }
interface Pkg { dir: string; json: Json }

const under = (dir: string, rel: string): string => (dir ? `${dir}/${rel}` : rel);

function stripExt(p: string): string {
  const m = /\.d\.[mc]?ts$|\.[mc]?[jt]sx?$/.exec(p);
  return m ? p.slice(0, m.index) : p;
}

/** Every string under a package.json `exports` / `imports` target, preferred conditions first. */
function targetStrings(v: unknown, out: string[], depth = 0): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) { for (const x of v) targetStrings(x, out, depth + 1); }
  else if (isObject(v) && depth < 6) {
    for (const k of CONDITIONS) if (k in v) targetStrings(v[k], out, depth + 1);
    for (const k of Object.keys(v)) if (!CONDITIONS.includes(k)) targetStrings(v[k], out, depth + 1);
  }
  return out;
}

/** Targets for `key` in an `exports` / `imports` map: an exact key, else the longest `prefix*suffix` pattern. */
function matchMap(map: Json, key: string): string[] {
  if (key in map) return targetStrings(map[key], []);
  let best: string | null = null, bestPrefix = -1, captured = '';
  for (const pattern of Object.keys(map)) {
    const star = pattern.indexOf('*');
    const prefix = star >= 0 ? pattern.slice(0, star) : pattern.endsWith('/') ? pattern : null;
    if (prefix === null) continue;
    const suffix = star >= 0 ? pattern.slice(star + 1) : '';
    if (key.length < prefix.length + suffix.length || !key.startsWith(prefix) || !key.endsWith(suffix)) continue;
    if (prefix.length > bestPrefix) { best = pattern; bestPrefix = prefix.length; captured = key.slice(prefix.length, key.length - suffix.length); }
  }
  if (best === null) return [];
  const isPattern = best.includes('*'); // otherwise a legacy "./dir/" mapping
  return targetStrings(map[best], []).map((t) => (t.includes('*') ? t.split('*').join(captured) : isPattern ? t : t + captured));
}

function exportTargets(exports: unknown, subpath: string): string[] {
  if (exports === undefined || exports === null) return [];
  const keyed = isObject(exports) && Object.keys(exports).some((k) => k.startsWith('.'));
  if (!keyed) return subpath === '.' ? targetStrings(exports, []) : [];
  return matchMap(exports as Json, subpath);
}

function createTsResolver(index: RepoIndex): Resolver {
  // ---- file probing ----
  const probe = (p: string | null): string | null => {
    if (p === null) return null;
    if (p && index.has(p)) return p;
    for (const [js, ts] of JS_TO_TS) {
      if (!p.endsWith(js)) continue;
      const stem = p.slice(0, -js.length);
      for (const e of ts) if (index.has(stem + e)) return stem + e;
    }
    if (p) for (const e of PROBE_EXTS) if (index.has(p + e)) return p + e;
    const idx = under(p, 'index');
    for (const e of PROBE_EXTS) if (index.has(idx + e)) return idx + e;
    return null;
  };

  // ---- tsconfig / jsconfig ----
  const jsonCache = new Map<string, Json | null>();
  const readJson = (path: string): Json | null => {
    let v = jsonCache.get(path);
    if (v === undefined) {
      const text = index.text(path);
      const parsed = text === undefined ? undefined : parseJsonc(text);
      v = isObject(parsed) ? parsed : null;
      jsonCache.set(path, v);
    }
    return v;
  };
  const configFile = (dir: string, ref: string): string | null => {
    const p = joinPath(dir, ref);
    if (p === null) return null;
    for (const c of [p, `${p}.json`, under(p, 'tsconfig.json')]) if (c.endsWith('.json') && index.has(c)) return c;
    return null;
  };
  const loadConfig = (path: string, depth: number): TsConfig | null => {
    const json = readJson(path);
    if (!json) return null;
    const dir = dirname(path);
    const cfg: TsConfig = { baseUrl: null, rules: null, pathsDir: dir };
    const ext = json.extends;
    const parents = typeof ext === 'string' ? [ext] : Array.isArray(ext) ? ext.filter((x): x is string => typeof x === 'string') : [];
    if (depth < MAX_EXTENDS) {
      for (const ref of parents) {
        const file = ref.startsWith('.') ? configFile(dir, ref) : null;
        const parent = file ? loadConfig(file, depth + 1) : null;
        if (!parent) continue;
        if (parent.baseUrl !== null) cfg.baseUrl = parent.baseUrl;
        if (parent.rules) { cfg.rules = parent.rules; cfg.pathsDir = parent.pathsDir; }
      }
    }
    const co = isObject(json.compilerOptions) ? json.compilerOptions : {};
    if (typeof co.baseUrl === 'string') { const b = joinPath(dir, co.baseUrl); if (b !== null) cfg.baseUrl = b; }
    if (isObject(co.paths)) {
      const rules: PathRule[] = [];
      for (const [pattern, value] of Object.entries(co.paths)) {
        const targets = Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
        if (!targets.length) continue;
        const star = pattern.indexOf('*');
        rules.push(star < 0 ? { prefix: pattern, suffix: '', star: false, targets } : { prefix: pattern.slice(0, star), suffix: pattern.slice(star + 1), star: true, targets });
      }
      cfg.rules = rules;
      cfg.pathsDir = dir;
    }
    return cfg;
  };
  const useful = (c: TsConfig | null): c is TsConfig => !!c && (c.baseUrl !== null || !!c.rules?.length);
  /** The config at `path`, or, for a solution-style config with nothing of its own, the ones it references. */
  const loadConfigs = (path: string): TsConfig[] => {
    const own = loadConfig(path, 0);
    if (useful(own)) return [own];
    const refs = readJson(path)?.references;
    const out: TsConfig[] = [];
    if (Array.isArray(refs)) {
      for (const r of refs) {
        const file = isObject(r) && typeof r.path === 'string' ? configFile(dirname(path), r.path) : null;
        const c = file && file !== path ? loadConfig(file, 0) : null;
        if (useful(c)) out.push(c);
      }
    }
    return out;
  };
  const configsByDir = new Map<string, TsConfig[]>();
  /** Configs that apply to files in `dir`, nearest first. */
  const configsFor = (dir: string): TsConfig[] => {
    let list = configsByDir.get(dir);
    if (!list) {
      const own: TsConfig[] = [];
      for (const name of CONFIG_NAMES) { const p = under(dir, name); if (index.has(p)) own.push(...loadConfigs(p)); }
      const inherited = dir === '' ? [] : configsFor(dirname(dir));
      list = own.length ? [...own, ...inherited] : inherited;
      configsByDir.set(dir, list);
    }
    return list;
  };
  const viaPaths = (cfg: TsConfig, spec: string): string | null => {
    if (!cfg.rules) return null;
    let best: PathRule | null = null;
    for (const r of cfg.rules) {
      if (!r.star) { if (r.prefix === spec) { best = r; break; } continue; }
      if (spec.length < r.prefix.length + r.suffix.length || !spec.startsWith(r.prefix) || !spec.endsWith(r.suffix)) continue;
      if (!best || r.prefix.length > best.prefix.length) best = r;
    }
    if (!best) return null;
    const base = cfg.baseUrl ?? cfg.pathsDir;
    const captured = best.star ? spec.slice(best.prefix.length, spec.length - best.suffix.length) : '';
    for (const t of best.targets) {
      const hit = probe(joinPath(base, best.star ? t.replace('*', captured) : t));
      if (hit) return hit;
    }
    return null;
  };

  // ---- packages ----
  const pkgByName = new Map<string, Pkg>();
  const pkgByDir = new Map<string, Pkg>();
  for (const path of [...index.byBasename('package.json')].sort((a, b) => a.length - b.length || (a < b ? -1 : 1))) {
    const json = readJson(path);
    if (!json) continue;
    const pkg: Pkg = { dir: dirname(path), json };
    pkgByDir.set(pkg.dir, pkg);
    if (typeof json.name === 'string' && json.name && !pkgByName.has(json.name)) pkgByName.set(json.name, pkg);
  }
  const nearestPkg = (dir: string): Pkg | null => {
    for (let d = dir; ; d = dirname(d)) {
      const p = pkgByDir.get(d);
      if (p) return p;
      if (d === '') return null;
    }
  };
  /** A file a package.json target refers to: the file itself, or the source it was built from. */
  const pkgFile = (pkg: Pkg, target: string): ResolvedImport | null => {
    const direct = probe(joinPath(pkg.dir, target));
    if (direct) return { path: direct, confidence: EXACT };
    const segs = target.split('/').filter((s) => s && s !== '.');
    if (segs.length < 2 || !BUILD_DIRS.has(segs[0])) return null;
    const rest = stripExt(segs.slice(1).join('/'));
    const guess = probe(joinPath(pkg.dir, 'src', rest)) ?? probe(joinPath(pkg.dir, rest));
    return guess ? { path: guess, confidence: GUESSED_SOURCE } : null;
  };
  const viaPackage = (spec: string): ResolvedImport | null => {
    const parts = spec.split('/');
    const nameParts = spec.startsWith('@') ? 2 : 1;
    if (parts.length < nameParts) return null;
    const pkg = pkgByName.get(parts.slice(0, nameParts).join('/'));
    if (!pkg) return null;
    const sub = parts.slice(nameParts).join('/');
    const candidates = exportTargets(pkg.json.exports, sub ? `./${sub}` : '.');
    if (sub) candidates.push(sub, `src/${sub}`);
    else {
      for (const field of ['source', 'module', 'main', 'types', 'typings']) { const v = pkg.json[field]; if (typeof v === 'string') candidates.push(v); }
      candidates.push('src/index', 'index');
    }
    for (const c of candidates) { const hit = pkgFile(pkg, c); if (hit) return hit; }
    return null;
  };
  const viaImportsField = (dir: string, spec: string): ResolvedImport | null => {
    const pkg = nearestPkg(dir);
    if (!pkg || !isObject(pkg.json.imports)) return null;
    for (const t of matchMap(pkg.json.imports, spec)) {
      const hit = t.startsWith('.') ? pkgFile(pkg, t) : viaPackage(t);
      if (hit) return hit;
    }
    return null;
  };

  // ---- one specifier from one directory ----
  const memo = new Map<string, ResolvedImport | null>();
  const resolveFrom = (dir: string, spec: string): ResolvedImport | null => {
    if (spec === '.' || spec === '..' || spec.startsWith('./') || spec.startsWith('../')) {
      const hit = probe(joinPath(dir, spec));
      return hit ? { path: hit, confidence: EXACT } : null;
    }
    if (spec.startsWith('/')) return null;
    if (spec.startsWith('#')) return viaImportsField(dir, spec);
    const configs = configsFor(dir);
    for (const cfg of configs) { const hit = viaPaths(cfg, spec); if (hit) return { path: hit, confidence: EXACT }; }
    for (const cfg of configs) {
      if (cfg.baseUrl === null) continue;
      const hit = probe(joinPath(cfg.baseUrl, spec));
      if (hit) return { path: hit, confidence: EXACT };
    }
    return viaPackage(spec);
  };

  return {
    resolve(file: FileFacts, imp: ImportSpec): ResolvedImport[] {
      let spec = imp.spec;
      const q = spec.indexOf('?'); // bundler suffixes: './x.svg?raw'
      if (q > 0) spec = spec.slice(0, q);
      if (!spec) return [];
      const dir = dirname(file.path);
      const key = `${dir}\0${spec}`;
      let hit = memo.get(key);
      if (hit === undefined) { hit = resolveFrom(dir, spec); memo.set(key, hit); }
      return hit && hit.path !== file.path ? [hit] : [];
    },
  };
}

const resolvers = new WeakMap<RepoIndex, Resolver>();
/** The TS/JS resolver for an index; one instance serves both plug-ins. */
export function tsResolver(index: RepoIndex): Resolver {
  let r = resolvers.get(index);
  if (!r) resolvers.set(index, (r = createTsResolver(index)));
  return r;
}
