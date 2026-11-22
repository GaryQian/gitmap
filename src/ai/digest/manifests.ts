// Build manifests reduced to names, targets and script names (PLAN.md §11.2), and the files they
// declare as entries. Only what the fast pass kept (FileFacts.excerpt) is read; nothing here quotes
// a manifest's values beyond names and paths, and script commands are never shown.
import { basename, dirname, joinPath } from '../../shared';
import type { Ctx } from './ctx';
import { cmpStr, oneLine } from './seeded';
import { LOCAL } from './tunables';

export interface ManifestInfo {
  path: string;
  /** Unit of the manifest file, or −1 when it has no sphere. */
  unit: number;
  depth: number;
  /** "name …; scripts …" */
  summary: string;
  /** Units the manifest declares as entries, with how. */
  entries: { unit: number; why: string }[];
}

interface Parsed {
  parts: string[];
  /** Candidate paths relative to the manifest's folder (the first that exists wins), with how it is declared. */
  entries: { paths: string[]; why: string }[];
}

const name = (s: unknown): string | null => (typeof s === 'string' && s.trim() ? oneLine(s, LOCAL.structure.nameChars) : null);

function listed(label: string, names: string[], max: number = LOCAL.structure.manifestScripts): string | null {
  const clean = names.map((n) => name(n)).filter((n): n is string => n !== null);
  if (clean.length === 0) return null;
  const more = clean.length > max ? ` (+${clean.length - max} more)` : '';
  return `${label} ${clean.slice(0, max).join(', ')}${more}`;
}

const JS_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

/** Where a JS entry may live: as written, with an extension, as a folder index, or as the source of a built file. */
function jsCandidates(spec: string): string[] {
  const out = [spec];
  const hasExt = /\.[A-Za-z0-9]+$/.test(basename(spec));
  if (!hasExt) for (const ext of JS_EXTENSIONS) out.push(spec + ext, `${spec}/index${ext}`);
  const built = /^(?:\.\/)?(?:dist|build|lib|out)\/(.+)\.[cm]?js$/.exec(spec);
  if (built) for (const ext of ['.ts', '.tsx', '.js']) out.push(`src/${built[1]}${ext}`, `${built[1]}${ext}`);
  return out;
}

function packageJson(text: string): Parsed | null {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof j !== 'object' || j === null || Array.isArray(j)) return null;
  const parts: string[] = [];
  const entries: Parsed['entries'] = [];
  const n = name(j.name);
  if (n) parts.push(`name "${n}"`);
  const workspaces = Array.isArray(j.workspaces) ? j.workspaces : (j.workspaces as { packages?: unknown } | undefined)?.packages;
  if (Array.isArray(workspaces)) { const w = listed('workspaces', workspaces.filter((x) => typeof x === 'string')); if (w) parts.push(w); }
  for (const key of ['main', 'module', 'browser'] as const) {
    const target = name(j[key]);
    if (!target) continue;
    parts.push(`${key} ${target}`);
    entries.push({ paths: jsCandidates(target), why: `package.json ${key}` });
  }
  const bin = j.bin;
  if (typeof bin === 'string') {
    parts.push(`bin ${name(bin)}`);
    entries.push({ paths: jsCandidates(bin), why: 'package.json bin' });
  } else if (bin && typeof bin === 'object') {
    const bins = Object.entries(bin as Record<string, unknown>).sort((a, b) => cmpStr(a[0], b[0]));
    const b = listed('bin', bins.map(([k]) => k));
    if (b) parts.push(b);
    for (const [k, v] of bins) if (typeof v === 'string') entries.push({ paths: jsCandidates(v), why: `package.json bin "${name(k)}"` });
  }
  if (j.scripts && typeof j.scripts === 'object') {
    const scripts = Object.entries(j.scripts as Record<string, unknown>);
    const s = listed('scripts', scripts.map(([k]) => k));
    if (s) parts.push(s);
    for (const [k, cmd] of scripts) {
      if (typeof cmd !== 'string') continue;
      // A script names an entry when one of its words is a file that exists.
      for (const word of cmd.split(/[\s"'=]+/)) {
        if (/^[\w@.\-/]+\.[A-Za-z0-9]+$/.test(word) && !word.startsWith('-')) entries.push({ paths: [word], why: `package.json script "${name(k)}"` });
      }
    }
  }
  return { parts, entries };
}

/** Tables of a TOML file: just `[name]` / `[[name]]` headers and `key = value` lines, values unquoted. */
function tomlTables(text: string): { table: string; values: Record<string, string> }[] {
  const tables: { table: string; values: Record<string, string> }[] = [{ table: '', values: {} }];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const header = /^\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(line);
    if (header) { tables.push({ table: header[1], values: {} }); continue; }
    const kv = /^("[^"]+"|'[^']+'|[\w.-]+)\s*=\s*(.*)$/.exec(line);
    if (kv) tables[tables.length - 1].values[kv[1].replace(/^["']|["']$/g, '')] = kv[2].replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '');
  }
  return tables;
}

const quotedStrings = (raw: string | undefined): string[] => (raw ? [...raw.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]) : []);

function cargoToml(text: string): Parsed {
  const parts: string[] = [];
  const entries: Parsed['entries'] = [];
  const bins: string[] = [];
  for (const { table, values } of tomlTables(text)) {
    if (table === 'package') {
      const n = name(values.name);
      if (n) parts.push(`name "${n}"`);
      entries.push({ paths: ['src/main.rs'], why: 'Cargo.toml binary crate' }, { paths: ['src/lib.rs'], why: 'Cargo.toml library crate' });
    } else if (table === 'lib') {
      const n = name(values.name);
      if (n) parts.push(`lib ${n}`);
      if (values.path) entries.push({ paths: [values.path], why: 'Cargo.toml lib' });
    } else if (table === 'bin') {
      if (values.name) bins.push(values.name);
      if (values.path) entries.push({ paths: [values.path], why: `Cargo.toml bin${values.name ? ` "${name(values.name)}"` : ''}` });
    } else if (table === 'workspace') {
      const m = listed('workspace members', quotedStrings(values.members));
      if (m) parts.push(m);
    }
  }
  const b = listed('bin', bins);
  if (b) parts.push(b);
  return { parts, entries };
}

function pyprojectToml(text: string): Parsed {
  const parts: string[] = [];
  const entries: Parsed['entries'] = [];
  const scripts: string[] = [];
  for (const { table, values } of tomlTables(text)) {
    if (table === 'project' || table === 'tool.poetry') {
      const n = name(values.name);
      if (n && parts.length === 0) parts.push(`name "${n}"`);
    } else if (table === 'project.scripts' || table === 'tool.poetry.scripts' || table === 'project.gui-scripts') {
      for (const [k, target] of Object.entries(values)) {
        scripts.push(k);
        // "package.module:function" names a module file.
        const module = target.split(':')[0].trim();
        if (!/^[\w.]+$/.test(module)) continue;
        const rel = module.replace(/\./g, '/');
        entries.push({
          paths: [`${rel}.py`, `src/${rel}.py`, `${rel}/__main__.py`, `src/${rel}/__main__.py`, `${rel}/__init__.py`, `src/${rel}/__init__.py`],
          why: `pyproject.toml script "${name(k)}"`,
        });
      }
    } else if (table === 'build-system') {
      const backend = name(values['build-backend']);
      if (backend) parts.push(`build backend ${backend}`);
    }
  }
  const s = listed('scripts', scripts);
  if (s) parts.push(s);
  return { parts, entries };
}

function goMod(text: string): Parsed {
  const parts: string[] = [];
  const module = /^module\s+(\S+)/m.exec(text);
  if (module) parts.push(`module ${name(module[1])}`);
  const go = /^go\s+(\S+)/m.exec(text);
  if (go) parts.push(`go ${name(go[1])}`);
  return { parts, entries: [{ paths: ['main.go'], why: 'Go module root' }] };
}

function pubspecYaml(text: string): Parsed {
  const parts: string[] = [];
  const entries: Parsed['entries'] = [{ paths: ['lib/main.dart'], why: 'pubspec.yaml app' }];
  const n = /^name:\s*["']?([\w.-]+)/m.exec(text);
  if (n) parts.push(`name "${name(n[1])}"`);
  const block = /^executables:[ \t]*\r?\n((?:[ \t]+.*\r?\n?)+)/m.exec(text);
  if (block) {
    const executables = [...block[1].matchAll(/^[ \t]+([\w-]+):[ \t]*([\w-]*)/gm)];
    const e = listed('executables', executables.map((m) => m[1]));
    if (e) parts.push(e);
    for (const m of executables) entries.push({ paths: [`bin/${m[2] || m[1]}.dart`], why: `pubspec.yaml executable "${name(m[1])}"` });
  }
  return { parts, entries };
}

function pomXml(text: string): Parsed {
  // The project's own coordinates sit outside these blocks.
  const own = text.replace(/<(parent|dependencies|dependencyManagement|build|profiles|reporting)>[\s\S]*?<\/\1>/g, '');
  const tag = (t: string) => name(new RegExp(`<${t}>\\s*([^<]+?)\\s*</${t}>`).exec(own)?.[1]);
  const parts: string[] = [];
  const artifact = tag('artifactId'), group = tag('groupId'), packaging = tag('packaging');
  if (artifact) parts.push(`artifact "${artifact}"`);
  if (group) parts.push(`group ${group}`);
  if (packaging) parts.push(`packaging ${packaging}`);
  const modules = listed('modules', [...text.matchAll(/<module>\s*([^<]+?)\s*<\/module>/g)].map((m) => m[1]));
  if (modules) parts.push(modules);
  return { parts, entries: [] };
}

function gradle(text: string): Parsed {
  const parts: string[] = [];
  const first = (re: RegExp) => name(re.exec(text)?.[1]);
  const root = first(/rootProject\.name\s*=\s*["']([^"']+)["']/);
  if (root) parts.push(`name "${root}"`);
  const group = first(/^\s*group\s*=?\s*["']([^"']+)["']/m);
  if (group) parts.push(`group ${group}`);
  const app = first(/applicationId\s*=?\s*["']([^"']+)["']/);
  if (app) parts.push(`application ${app}`);
  const main = first(/mainClass(?:Name)?(?:\.set)?\s*[=(]\s*["']([^"']+)["']/);
  if (main) parts.push(`main class ${main}`);
  const includes = [...text.matchAll(/^\s*include\s*\(?\s*(.+)$/gm)].flatMap((m) => quotedStrings(m[1]));
  const modules = listed('modules', includes);
  if (modules) parts.push(modules);
  return { parts, entries: [] };
}

const PARSERS: Record<string, (text: string) => Parsed | null> = {
  'package.json': packageJson,
  'go.mod': goMod,
  'Cargo.toml': cargoToml,
  'pyproject.toml': pyprojectToml,
  'pubspec.yaml': pubspecYaml,
  'pom.xml': pomXml,
  'build.gradle': gradle,
  'build.gradle.kts': gradle,
  'settings.gradle': gradle,
  'settings.gradle.kts': gradle,
};

/** Every readable manifest, shallowest first. */
export function readManifests(ctx: Ctx): ManifestInfo[] {
  return ctx.once('manifests', () => {
    const out: ManifestInfo[] = [];
    for (const f of ctx.facts.values()) {
      const parse = PARSERS[basename(f.path)];
      if (!parse || f.excerpt === undefined || !ctx.pathShown(f.path) || ctx.fileWithheld(f.path)) continue;
      const parsed = parse(f.excerpt);
      if (!parsed || parsed.parts.length === 0) continue;
      const dir = dirname(f.path);
      const entries: ManifestInfo['entries'] = [];
      const seen = new Set<number>();
      for (const e of parsed.entries) {
        for (const rel of e.paths) {
          const path = joinPath(dir, rel);
          const unit = path === null ? undefined : ctx.view.unitOfFile.get(path);
          if (unit === undefined) continue;
          if (!seen.has(unit)) { seen.add(unit); entries.push({ unit, why: e.why }); }
          break;
        }
      }
      out.push({
        path: f.path, unit: ctx.view.unitOfFile.get(f.path) ?? -1, depth: dir === '' ? 0 : dir.split('/').length,
        summary: parsed.parts.join('; '), entries,
      });
    }
    return out.sort((a, b) => a.depth - b.depth || cmpStr(a.path, b.path));
  });
}
