// Conventional bundler aliases: where `@/x`, `~/x` and `$lib/x` point when no config in the repo
// says so. One definition for the TS/JS resolver and the web plug-ins (stylesheets, components).
import { dirname, joinPath } from './index';

/** `dir` and every directory above it, nearest first, ending with the root (''). */
export function ancestors(dir: string): string[] {
  const out = [dir];
  for (let d = dir; d !== ''; ) out.push((d = dirname(d)));
  return out;
}

/**
 * The path behind a conventional bundler alias, or null: `@/x` and `~/x` (the source root of Vue CLI,
 * Vite and Nuxt projects) and `$lib/x` (SvelteKit, whose tsconfig is generated and not in the repo).
 * The alias is exactly `@/…`: `@scope/name` is a package. Used only when no tsconfig maps the specifier.
 */
export function aliasRest(spec: string): string | null {
  if (spec.startsWith('@/') || spec.startsWith('~/')) return spec.slice(2);
  if (spec.startsWith('$lib/')) return spec.slice(1);
  return null;
}

/**
 * Repo paths an alias path may stand for, likeliest first: under a `src/` folder beside or above
 * `dir`, then in `roots` (project roots the caller knows), or, when none are given, beside or above
 * `dir` itself.
 */
export function aliasCandidates(dir: string, rest: string, roots?: readonly string[]): string[] {
  const dirs = ancestors(dir);
  const out: string[] = [];
  for (const d of dirs) { const p = joinPath(d, 'src', rest); if (p) out.push(p); }
  for (const d of roots ?? dirs) { const p = joinPath(d, rest); if (p) out.push(p); }
  return out;
}
