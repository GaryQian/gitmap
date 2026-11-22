// A gitignore matcher that follows git's own rules (dir.c and wildmatch.c), so a plain folder gets
// the same file list `git ls-files` would give it.
//
// Each .gitignore is compiled once into an IgnoreRules; a path is then judged against the chain of
// rule sets that apply to its directory: the nearest .gitignore first, then each parent's, then
// .git/info/exclude. The first set with any matching pattern decides, and inside a set the last
// matching line wins.
//
// Known differences from git:
// - Global ignore files outside the repo (core.excludesFile, ~/.config/git/ignore) are not read.
// - .gitattributes plays no part.
// - git matches bytes; this matches UTF-16 code units, so `?` and `[...]` see a non-ASCII character
//   as one or two units where git sees two to four bytes.

export interface CompileOptions {
  /** Match case-insensitively, as git does when core.ignorecase is set (its default on Windows and macOS). */
  ignoreCase?: boolean;
}

interface Rule {
  negated: boolean;
  /** The pattern ended with '/': it matches directories only. */
  dirOnly: boolean;
  /** No slash in the pattern: it is matched against the file name alone, at any depth. */
  nameOnly: boolean;
  /** Exact text to equal (a pattern with no wildcard), when not null. */
  literal: string | null;
  /** Text the name must end with ("*.log"), when not null. */
  suffix: string | null;
  /** Sticky regular expression for every other pattern. */
  regex: RegExp | null;
}

/** The compiled patterns of one .gitignore file (or of .git/info/exclude). */
export interface IgnoreRules {
  /** Directory that holds the file; '' for the root and for info/exclude. */
  readonly base: string;
  /** Number of patterns that can match something. */
  readonly size: number;
  /**
   * Judge one path. `path` is repo-relative and lies under `base`; `nameStart` is the index of its
   * last segment. Returns true = ignored, false = re-included by a `!` line, null = no pattern matches.
   * Says nothing about parent directories: see IgnoreMatcher.
   */
  match(path: string, nameStart: number, isDir: boolean): boolean | null;
}

const NEVER: Rule[] = [];
const POSIX_CLASS: Record<string, string> = {
  alnum: 'A-Za-z0-9', alpha: 'A-Za-z', blank: ' \\t', cntrl: '\\x00-\\x1f\\x7f', digit: '0-9', graph: '\\x21-\\x7e',
  lower: 'a-z', print: '\\x20-\\x7e', punct: '!-\\/:-@\\[-`{-~', space: ' \\t\\n\\v\\f\\r', upper: 'A-Z', xdigit: '0-9A-Fa-f',
};

const escapeRe = (s: string): string => s.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');
const escapeInClass = (c: string): string => (c === '\\' || c === ']' || c === '[' || c === '^' || c === '-' ? '\\' + c : c);
const isGlobSpecial = (c: string): boolean => c === '*' || c === '?' || c === '[' || c === '\\';

/** Length of the leading part of a pattern that holds no wildcard (git's simple_length). */
function simpleLength(p: string): number {
  for (let i = 0; i < p.length; i++) if (isGlobSpecial(p[i])) return i;
  return p.length;
}

/**
 * Translate a wildmatch pattern into regular-expression source. `pathMode` is git's WM_PATHNAME:
 * `*`, `?` and `[...]` stop at '/', and `**` is special between slashes. Returns null for a pattern
 * that can never match (an unclosed '[', a trailing backslash, an unknown [:class:]).
 *
 * `fold` is case-insensitive matching. git folds the text to lower case but leaves an escaped letter
 * and a letter inside `[...]` as written, so an upper-case one there matches nothing ("[Bb]in" still
 * finds "Bin" through its "b"). The same is done here so the two agree.
 */
function wildToRegex(p: string, pathMode: boolean, fold: boolean): string | null {
  const dead = (c: string): boolean => fold && c >= 'A' && c <= 'Z';
  const n = p.length;
  let out = '';
  let i = 0;
  while (i < n) {
    const c = p[i];
    if (c === '\\') {
      if (++i >= n) return null;
      out += dead(p[i]) ? '(?!)' : escapeRe(p[i]);
      i++;
    } else if (c === '?') {
      out += '[^/]';
      i++;
    } else if (c === '*') {
      const start = i;
      while (i < n && p[i] === '*') i++;
      // "**" counts only as a whole path segment: after the start or a '/', before the end or a '/'.
      const special = pathMode && i - start >= 2 && (start === 0 || p[start - 1] === '/')
        && (i === n || p[i] === '/' || (p[i] === '\\' && p[i + 1] === '/'));
      if (!special) out += '[^/]*';
      else if (p[i] === '/') { out += '(?:.*/)?'; i++; } // "**/" also matches no directory at all
      else out += '.*';
    } else if (c === '[') {
      let j = i + 1;
      const negated = p[j] === '!' || p[j] === '^';
      if (negated) j++;
      let set = '';
      let prev = ''; // the previous literal, '' when a range cannot start here
      do {
        if (j >= n) return null;
        let ch = p[j];
        if (ch === '\\') {
          if (++j >= n) return null;
          ch = p[j];
          if (!dead(ch)) set += escapeInClass(ch);
          prev = ch;
        } else if (ch === '-' && prev && j + 1 < n && p[j + 1] !== ']') {
          ch = p[++j];
          if (ch === '\\') {
            if (++j >= n) return null;
            ch = p[j];
          }
          if (prev <= ch) set += `${escapeInClass(prev)}-${escapeInClass(ch)}`; // a reversed range matches nothing
          prev = '';
        } else if (ch === '[' && p[j + 1] === ':') {
          const s = j + 2;
          let k = s;
          while (k < n && p[k] !== ']') k++;
          if (k >= n) return null;
          if (k - s - 1 < 0 || p[k - 1] !== ':') {
            set += '\\['; // no ":]" follows: an ordinary '['
            prev = '[';
          } else {
            const cls = POSIX_CLASS[p.slice(s, k - 1)];
            if (!cls) return null;
            set += cls;
            prev = '';
            j = k;
          }
        } else {
          if (!dead(ch)) set += escapeInClass(ch);
          prev = ch;
        }
        j++;
      } while (p[j] !== ']');
      i = j + 1;
      out += negated ? `[^/${set}]` : `(?!/)[${set}]`;
    } else {
      out += escapeRe(c);
      i++;
    }
  }
  return out;
}

/** git's trim_trailing_spaces: drop trailing spaces unless a backslash protects them. */
function trimTrailingSpaces(line: string): string {
  let lastSpace = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === ' ') { if (lastSpace < 0) lastSpace = i; } else {
      if (c === '\\' && ++i >= line.length) return line;
      lastSpace = -1;
    }
  }
  return lastSpace < 0 ? line : line.slice(0, lastSpace);
}

function compileLine(line: string, ignoreCase: boolean): Rule | null {
  let p = line;
  const negated = p.startsWith('!');
  if (negated) p = p.slice(1);
  const dirOnly = p.endsWith('/');
  if (dirOnly) p = p.slice(0, -1);
  if (p === '') return null;
  const nameOnly = !p.includes('/');
  const flags = ignoreCase ? 'isy' : 'sy';
  // One leading slash only anchors the pattern; it is not part of what is matched.
  if (!nameOnly && p[0] === '/') p = p.slice(1);
  const source = wildToRegex(p, !nameOnly, ignoreCase);
  if (source === null) return null;
  const rule: Rule = { negated, dirOnly, nameOnly, literal: null, suffix: null, regex: null };
  // Plain names and "*.ext" are the bulk of real files: compare text instead of running a regex.
  if (!ignoreCase && simpleLength(p) === p.length) rule.literal = p;
  else if (!ignoreCase && nameOnly && p[0] === '*' && simpleLength(p.slice(1)) === p.length - 1) rule.suffix = p.slice(1);
  else rule.regex = new RegExp(`${source}$`, flags);
  return rule;
}

/**
 * Compile the text of one .gitignore. `base` is the directory that holds it ('' for the root, and
 * for .git/info/exclude).
 */
export function compileIgnore(text: string, base = '', opts: CompileOptions = {}): IgnoreRules {
  const ignoreCase = opts.ignoreCase === true;
  let rules: Rule[] = NEVER;
  const lines = text.replace(/^\uFEFF/, '').split('\n');
  for (let raw of lines) {
    if (raw === '' || raw[0] === '#') continue;
    if (raw.endsWith('\r')) raw = raw.slice(0, -1);
    const rule = compileLine(trimTrailingSpaces(raw), ignoreCase);
    if (rule) (rules === NEVER ? (rules = []) : rules).push(rule);
  }
  const baseLen = base === '' ? 0 : base.length + 1;
  const count = rules.length;
  return {
    base,
    size: count,
    match(path, nameStart, isDir) {
      const nameLen = path.length - nameStart;
      const relLen = path.length - baseLen;
      for (let i = count - 1; i >= 0; i--) {
        const r = rules[i];
        if (r.dirOnly && !isDir) continue;
        const from = r.nameOnly ? nameStart : baseLen;
        const len = r.nameOnly ? nameLen : relLen;
        let hit: boolean;
        if (r.literal !== null) hit = len === r.literal.length && path.startsWith(r.literal, from);
        else if (r.suffix !== null) hit = len >= r.suffix.length && path.endsWith(r.suffix);
        else {
          const re = r.regex!;
          re.lastIndex = from;
          hit = re.test(path);
        }
        if (hit) return !r.negated;
      }
      return null;
    },
  };
}

/**
 * Verdict of a chain of rule sets, nearest directory first: true when the path is ignored. The
 * caller has already established that no parent directory is ignored.
 */
export function chainIgnores(chain: readonly IgnoreRules[], path: string, nameStart: number, isDir: boolean): boolean {
  for (let i = 0; i < chain.length; i++) {
    const verdict = chain[i].match(path, nameStart, isDir);
    if (verdict !== null) return verdict;
  }
  return false;
}

const parentOf = (path: string): string => {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
};

/**
 * The ignore rules of a whole tree, for judging any path on its own (the walk keeps its own chain as
 * it descends and does not need this). Register every .gitignore with `add`, then ask `ignores`.
 * Like git, a path under an ignored directory is ignored whatever a `!` line says.
 */
export class IgnoreMatcher {
  private files = new Map<string, IgnoreRules>();
  private exclude: IgnoreRules | null = null;
  private chains = new Map<string, IgnoreRules[]>();
  private dirs = new Map<string, boolean>();

  constructor(private opts: CompileOptions = {}) {}

  /** Register the .gitignore held by directory `dir` ('' is the root). */
  add(dir: string, text: string): void {
    this.files.set(dir, compileIgnore(text, dir, this.opts));
    this.chains.clear();
    this.dirs.clear();
  }

  /** Register .git/info/exclude: root-relative patterns that every .gitignore overrides. */
  addExclude(text: string): void {
    this.exclude = compileIgnore(text, '', this.opts);
    this.chains.clear();
    this.dirs.clear();
  }

  /** Rule sets that apply to the entries of `dir`, nearest first. */
  private chain(dir: string): IgnoreRules[] {
    let chain = this.chains.get(dir);
    if (!chain) {
      const outer = dir === '' ? (this.exclude ? [this.exclude] : []) : this.chain(parentOf(dir));
      const own = this.files.get(dir);
      chain = own && own.size ? [own, ...outer] : outer;
      this.chains.set(dir, chain);
    }
    return chain;
  }

  private dirIgnored(dir: string): boolean {
    if (dir === '') return false;
    let verdict = this.dirs.get(dir);
    if (verdict === undefined) {
      const parent = parentOf(dir);
      verdict = this.dirIgnored(parent) || chainIgnores(this.chain(parent), dir, parent === '' ? 0 : parent.length + 1, true);
      this.dirs.set(dir, verdict);
    }
    return verdict;
  }

  /** True when git would leave the path out: it matches, or a directory above it does. */
  ignores(path: string, isDir = false): boolean {
    if (isDir) return this.dirIgnored(path);
    const parent = parentOf(path);
    return this.dirIgnored(parent) || chainIgnores(this.chain(parent), path, parent === '' ? 0 : parent.length + 1, false);
  }
}
