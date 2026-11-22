// Path helpers shared by the web plug-ins (stylesheets, HTML, Vue / Svelte / Astro): which specifiers
// can name a file of the repo at all, and where root-relative and alias paths may point.
import type { FileFacts, RepoIndex, ResolvedImport } from '../../contracts/lang';
import { dirname, joinPath } from '../../shared';
import { tsResolver } from '../ts';

/** A web root or alias target found by convention (a `public/` folder, a `src/` folder) rather than read from config. */
export const CONVENTION = 0.9;

/** The specifier without its `?query` and `#fragment` (`font.woff2?v=3#iefix`, `./icon.svg?raw`). */
export function cleanSpec(spec: string): string {
  const cut = spec.search(/[?#]/);
  return (cut < 0 ? spec : spec.slice(0, cut)).trim();
}

/**
 * False for anything that cannot be a file of the repo: URLs with a scheme (`https:`, `data:`,
 * `sass:math`), protocol-relative URLs, fragments, and values built by a preprocessor or a template
 * (`$var`, `#{…}`, `@{…}`, `{{ … }}`, `<%= … %>`, `var(--x)`).
 */
export function isLocalSpec(spec: string): boolean {
  return spec !== '' && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(spec) && !/[${(<]/.test(spec);
}

/** `dir` and every directory above it, nearest first, ending with the root (''). */
function ancestors(dir: string): string[] {
  const out = [dir];
  for (let d = dir; d !== ''; ) out.push((d = dirname(d)));
  return out;
}

/**
 * The file a root-relative URL (`/assets/app.js`) refers to: against the importing file's own
 * directory and each directory above it up to the repo root, and against a `public/` folder in each
 * (the nearest wins). `probe` maps a candidate repo path to an existing file.
 */
export function resolveRootRelative(
  index: RepoIndex,
  dir: string,
  spec: string,
  probe: (path: string) => string | null = (p) => (index.has(p) ? p : null),
): ResolvedImport | null {
  for (const d of ancestors(dir)) {
    for (const base of [d, d ? `${d}/public` : 'public']) {
      const candidate = joinPath(base, spec);
      const hit = candidate ? probe(candidate) : null;
      if (hit) return { path: hit, confidence: base === dir || base === '' ? 1 : CONVENTION };
    }
  }
  return null;
}

/**
 * The path behind a conventional bundler alias, or null: `@/x` and `~/x` (the source root of Vue CLI,
 * Vite and Nuxt projects) and `$lib/x` (SvelteKit). Used only when no tsconfig maps the specifier.
 */
export function aliasRest(spec: string): string | null {
  if (spec.startsWith('@/') || spec.startsWith('~/')) return spec.slice(2);
  if (spec.startsWith('$lib/')) return spec.slice(1);
  return null;
}

/** Repo paths an alias path may stand for: under a `src/` folder beside or above `dir` first, then beside or above `dir` itself. */
export function aliasCandidates(dir: string, rest: string): string[] {
  const dirs = ancestors(dir);
  const out: string[] = [];
  for (const d of dirs) { const p = joinPath(d, 'src', rest); if (p) out.push(p); }
  for (const d of dirs) { const p = joinPath(d, rest); if (p) out.push(p); }
  return out;
}

/** A file at the repo root that imports are resolved "from" when a repo path needs the TS/JS probing. */
const ROOT_FILE: FileFacts = { path: '', oid: '', bytes: 0, lang: null, loc: 0, imports: [] };

/** The module at repo path `path` as the TS/JS resolver finds it: the file itself, with an extension added, `x.js` for `x.ts`, or its index file. */
export function probeModule(index: RepoIndex, path: string): string | null {
  return tsResolver(index).resolve(ROOT_FILE, { spec: `./${path}`, kind: 'import' })[0]?.path ?? null;
}
