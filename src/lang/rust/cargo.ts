// Cargo.toml, as far as the resolver needs it: the package and library names, target paths, the
// edition, and dependency renames. The TOML reader is a tolerant subset (tables, arrays of tables,
// dotted and quoted keys, strings, arrays, inline tables); numbers and dates stay strings, and a
// line it cannot read is skipped.

export type TomlValue = string | boolean | TomlValue[] | TomlTable;
export interface TomlTable { [key: string]: TomlValue }

const newTable = (): TomlTable => Object.create(null) as TomlTable;
const isTable = (v: TomlValue | undefined): v is TomlTable => typeof v === 'object' && !Array.isArray(v);

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' };

export function parseToml(text: string): TomlTable {
  const n = text.length;
  const root = newTable();
  let table = root;
  let i = 0;

  const fail = (): never => { throw new Error('toml'); };
  /** Skips blanks and comments; line breaks too when `lines`. */
  const skip = (lines: boolean) => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 32 || c === 9 || (lines && (c === 10 || c === 13))) i++;
      else if (c === 35) { while (i < n && text.charCodeAt(i) !== 10) i++; } else break;
    }
  };
  const readString = (): string => {
    const q = text[i];
    if (text.startsWith(q + q + q, i)) { // multi-line; escapes are left as written
      const end = text.indexOf(q + q + q, i + 3);
      const s = text.slice(i + 3, end < 0 ? n : end);
      i = end < 0 ? n : end + 3;
      return s;
    }
    let out = '';
    for (i++; i < n; i++) {
      const ch = text[i];
      if (ch === q) { i++; return out; }
      if (ch === '\n') break;
      if (ch === '\\' && q === '"') { i++; out += ESCAPES[text[i]] ?? text[i] ?? ''; } else out += ch;
    }
    return fail();
  };
  const readKey = (): string[] => {
    const keys: string[] = [];
    for (;;) {
      skip(false);
      const c = text[i];
      if (c === '"' || c === "'") keys.push(readString());
      else {
        const start = i;
        while (i < n && /[A-Za-z0-9_-]/.test(text[i])) i++;
        if (i === start) fail();
        keys.push(text.slice(start, i));
      }
      skip(false);
      if (text[i] !== '.') return keys;
      i++;
    }
  };
  /** The table at `keys` under `from`, created as needed; the last element of an array of tables. */
  const descend = (from: TomlTable, keys: string[], append: boolean): TomlTable => {
    let t = from;
    for (let k = 0; k < keys.length; k++) {
      const key = keys[k];
      const cur = t[key];
      if (append && k === keys.length - 1) {
        const list = Array.isArray(cur) ? cur : (t[key] = []);
        const fresh = newTable();
        list.push(fresh);
        return fresh;
      }
      const last = Array.isArray(cur) ? cur[cur.length - 1] : cur;
      t = isTable(last) ? last : (t[key] = newTable());
    }
    return t;
  };
  const readValue = (depth: number): TomlValue => {
    if (depth > 32) fail();
    const c = text[i];
    if (c === '"' || c === "'") return readString();
    if (c === '[') {
      const list: TomlValue[] = [];
      i++;
      for (;;) {
        skip(true);
        if (i >= n) fail();
        if (text[i] === ']') { i++; return list; }
        list.push(readValue(depth + 1));
        skip(true);
        if (text[i] === ',') i++; else if (text[i] !== ']') fail();
      }
    }
    if (c === '{') {
      const t = newTable();
      i++;
      for (;;) {
        skip(true);
        if (i >= n) fail();
        if (text[i] === '}') { i++; return t; }
        const keys = readKey();
        if (text[i] !== '=') fail();
        i++;
        skip(false);
        descend(t, keys.slice(0, -1), false)[keys[keys.length - 1]] = readValue(depth + 1);
        skip(true);
        if (text[i] === ',') i++; else if (text[i] !== '}') fail();
      }
    }
    const start = i;
    while (i < n && !/[,\]}#\r\n]/.test(text[i])) i++;
    const word = text.slice(start, i).trim();
    if (!word) fail();
    return word === 'true' ? true : word === 'false' ? false : word;
  };

  while (i < n) {
    skip(true);
    if (i >= n) break;
    try {
      if (text[i] === '[') {
        const array = text[i + 1] === '[';
        i += array ? 2 : 1;
        const keys = readKey();
        if (text[i] !== ']') fail();
        table = descend(root, keys, array);
      } else {
        const keys = readKey();
        if (text[i] !== '=') fail();
        i++;
        skip(false);
        const value = readValue(0);
        descend(table, keys.slice(0, -1), false)[keys[keys.length - 1]] = value;
        continue;
      }
    } catch { /* fall through: drop the rest of this line */ }
    while (i < n && text.charCodeAt(i) !== 10) i++;
  }
  return root;
}

/** Crate names use underscores where package names may use hyphens. */
export const crateName = (name: string): string => name.replace(/-/g, '_');

export interface Manifest {
  /** Directory of the Cargo.toml; '' at the repo root. */
  dir: string;
  /** `[package] name` as written; null for a virtual manifest (a workspace root with no package). */
  packageName: string | null;
  /** `[lib] name`, when it differs from the package name. */
  libName: string | null;
  /** `[lib] path`, relative to `dir`; null for the default src/lib.rs. */
  libPath: string | null;
  /** Explicit `path`s of [[bin]], [[example]], [[test]], [[bench]] targets and the build script. */
  targetPaths: string[];
  /** `[package] edition`; 'workspace' when inherited; null when absent (which means 2015). */
  edition: string | null;
  /** Renamed dependencies: the name used in code → the crate name of the package it stands for. */
  renames: Map<string, string>;
  /** Present when the manifest has a `[workspace]` table. */
  workspace: { edition: string | null; renames: Map<string, string> } | null;
  /** False when the file's text was not kept; every field is then a default. */
  known: boolean;
}

function collectRenames(deps: TomlValue | undefined, into: Map<string, string>): void {
  if (!isTable(deps)) return;
  for (const alias of Object.keys(deps)) {
    const dep = deps[alias];
    if (isTable(dep) && typeof dep.package === 'string') into.set(crateName(alias), crateName(dep.package));
  }
}
const DEPENDENCY_TABLES = ['dependencies', 'dev-dependencies', 'build-dependencies'];

export function readManifest(dir: string, text: string | undefined): Manifest {
  const m: Manifest = { dir, packageName: null, libName: null, libPath: null, targetPaths: [], edition: null, renames: new Map(), workspace: null, known: text !== undefined };
  if (text === undefined) {
    const base = dir.slice(dir.lastIndexOf('/') + 1);
    m.packageName = base || null;
    return m;
  }
  const toml = parseToml(text);
  const pkg = toml.package;
  if (isTable(pkg)) {
    if (typeof pkg.name === 'string') m.packageName = pkg.name;
    m.edition = typeof pkg.edition === 'string' ? pkg.edition : isTable(pkg.edition) ? 'workspace' : null;
    if (typeof pkg.build === 'string') m.targetPaths.push(pkg.build);
  }
  if (isTable(toml.lib)) {
    if (typeof toml.lib.name === 'string') m.libName = crateName(toml.lib.name);
    if (typeof toml.lib.path === 'string') m.libPath = toml.lib.path;
  }
  for (const kind of ['bin', 'example', 'test', 'bench']) {
    const targets = toml[kind];
    if (!Array.isArray(targets)) continue;
    for (const t of targets) if (isTable(t) && typeof t.path === 'string') m.targetPaths.push(t.path);
  }
  for (const key of DEPENDENCY_TABLES) collectRenames(toml[key], m.renames);
  if (isTable(toml.target)) {
    for (const cfg of Object.keys(toml.target)) {
      const t = toml.target[cfg];
      if (isTable(t)) for (const key of DEPENDENCY_TABLES) collectRenames(t[key], m.renames);
    }
  }
  if (isTable(toml.workspace)) {
    const ws = toml.workspace;
    const edition = isTable(ws.package) && typeof ws.package.edition === 'string' ? ws.package.edition : null;
    m.workspace = { edition, renames: new Map() };
    collectRenames(ws.dependencies, m.workspace.renames);
  }
  return m;
}
