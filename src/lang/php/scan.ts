// Fast-pass scanner for PHP (PLAN.md §6.3). No syntax tree.
//
// A first sweep writes a same-length mask of the source: inline HTML outside `<?php … ?>` and
// comments become spaces, string contents become FILL (the quotes stay), and a heredoc or nowdoc
// becomes one run of FILL. A second sweep finds the statement keywords and braces in the mask and
// reads what follows each. Brace depth tells a namespace-level `use` (an import) from a trait `use`
// in a class body; a closure's `use (…)` is followed by a parenthesis, not a name.
import type { ImportSpec, ScanResult } from '../../contracts/lang';

/** Code unit written over string contents: not whitespace, not an identifier character. */
const FILL = 0x7f;
const SPACE = 32;
/** `dirname(__DIR__, n)` beyond this many levels is not a path inside any repo. */
const MAX_DIR_LEVELS = 32;

// charCodeAt past the end is NaN, which fails every comparison: these are false there.
const isNameStart = (c: number): boolean => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c >= 128;
const isNameChar = (c: number): boolean => isNameStart(c) || (c >= 48 && c <= 57);
const isSpace = (c: number): boolean => c === 32 || c === 10 || c === 9 || c === 13 || c === 12;

function skipSpace(m: string, i: number): number {
  while (isSpace(m.charCodeAt(i))) i++;
  return i;
}
function nameEnd(m: string, i: number): number {
  while (isNameChar(m.charCodeAt(i))) i++;
  return i;
}
/** End of a qualified name: identifiers joined (or led) by backslashes. */
function qualifiedEnd(m: string, i: number): number {
  for (;;) {
    const c = m.charCodeAt(i);
    if (!(isNameChar(c) || c === 92)) return i;
    i++;
  }
}

/**
 * Index just past the closing label of the heredoc or nowdoc whose `<<<` is at `i`; the text length
 * when it never closes; -1 when `<<<` does not open one.
 */
function heredocEnd(s: string, i: number): number {
  let j = i + 3;
  while (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9) j++;
  const q = s.charCodeAt(j);
  const quoted = q === 39 || q === 34;
  if (quoted) j++;
  const start = j;
  if (!isNameStart(s.charCodeAt(j))) return -1;
  j = nameEnd(s, j);
  const label = s.slice(start, j);
  if (quoted) {
    if (s.charCodeAt(j) !== q) return -1;
    j++;
  }
  if (s.charCodeAt(j) === 13) j++;
  if (s.charCodeAt(j) !== 10) return -1;
  // The closing label starts a line (after optional indentation) and is not the start of a longer name.
  for (let line = j + 1; line <= s.length;) {
    let k = line;
    while (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9) k++;
    if (s.startsWith(label, k) && !isNameChar(s.charCodeAt(k + label.length))) return k + label.length;
    const nl = s.indexOf('\n', k);
    if (nl < 0) break;
    line = nl + 1;
  }
  return s.length;
}

/**
 * Same-length copy of `s` with everything that is not PHP code made inert: inline HTML and comments
 * become spaces, string contents become FILL, a heredoc becomes FILL from `<<<` to its closing
 * label, and a closing `?>` becomes the `;` it stands for.
 */
export function maskPhp(s: string): string {
  const n = s.length;
  const out = new Uint16Array(n);
  for (let k = 0; k < n; k++) out[k] = s.charCodeAt(k);
  let i = 0;
  while (i < n) {
    // Inline HTML, up to and including the next opening tag.
    const open = s.indexOf('<?', i);
    if (open < 0) { out.fill(SPACE, i); break; }
    let code = open + 2;
    if (s.charCodeAt(code) === 61) code++; // <?=
    else if (s.slice(code, code + 3).toLowerCase() === 'php' && !isNameChar(s.charCodeAt(code + 3))) code += 3;
    else if (isNameStart(s.charCodeAt(code))) { out.fill(SPACE, i, code); i = code; continue; } // <?xml …
    out.fill(SPACE, i, code);
    i = code;
    // PHP, up to and including the closing tag.
    while (i < n) {
      const c = s.charCodeAt(i);
      const d = s.charCodeAt(i + 1);
      if (c === 63 && d === 62) { out[i] = 59; out[i + 1] = SPACE; i += 2; break; }
      if ((c === 47 && d === 47) || (c === 35 && d !== 91)) { // `//` or `#`, but not the attribute `#[`
        while (i < n) {
          const e = s.charCodeAt(i);
          if (e === 10 || (e === 63 && s.charCodeAt(i + 1) === 62)) break; // `?>` ends a line comment
          out[i++] = SPACE;
        }
        continue;
      }
      if (c === 47 && d === 42) {
        const end = s.indexOf('*/', i + 2);
        const to = end < 0 ? n : end + 2;
        out.fill(SPACE, i, to);
        i = to;
        continue;
      }
      if (c === 39 || c === 34 || c === 96) {
        i++;
        while (i < n) {
          const e = s.charCodeAt(i);
          if (e === 92) { out[i] = FILL; if (i + 1 < n) out[i + 1] = FILL; i += 2; continue; }
          if (e === c) { i++; break; }
          out[i++] = FILL;
        }
        continue;
      }
      if (c === 60 && d === 60 && s.charCodeAt(i + 2) === 60) {
        const end = heredocEnd(s, i);
        if (end < 0) { i += 3; continue; }
        out.fill(FILL, i, end);
        i = end;
        continue;
      }
      i++;
    }
  }
  let masked = '';
  const CHUNK = 0x4000;
  for (let k = 0; k < n; k += CHUNK) masked += String.fromCharCode.apply(null, out.subarray(k, Math.min(n, k + CHUNK)) as unknown as number[]);
  return masked;
}

/**
 * The import spec for a literal include path, or null when it names nothing inside the repo.
 * `up` is the number of directories above the including file's own that a `__DIR__` / `dirname(…)`
 * prefix climbs, or -1 when the literal stands alone. Anchored paths come back starting with '.'.
 */
function includeSpec(raw: string, interpolating: boolean, up: number): string | null {
  if (interpolating && raw.includes('$')) return null;
  let path = raw.includes('\\') ? raw.replace(/\\+/g, '/') : raw;
  if (up < 0) {
    // Absolute paths, drive letters and stream wrappers (`phar://…`) are not repo files.
    return !path || path.charCodeAt(0) === 47 || path.includes(':') ? null : path;
  }
  if (path.charCodeAt(0) !== 47) return null; // `__DIR__ . 'x.php'` glues the name onto the directory's
  path = path.replace(/^\/+/, '');
  if (!path) return null;
  if (up > 0) return '../'.repeat(up) + path;
  return path.charCodeAt(0) === 46 ? path : './' + path;
}

/**
 * Imports and declarations of a PHP source text.
 *
 * Imports, kind 'use': one per imported name of `use A\B\C;`, `use A\B\C as D;`, `use A\{B, C as D};`,
 * `use function A\b;` and `use const A\B;`. `spec` is the fully-qualified name without a leading
 * backslash; `names` holds the one local name it binds (the alias, else the last segment).
 * Imports, kind 'require': `require` / `require_once` / `include` / `include_once` of a literal
 * path. `__DIR__ . '/x.php'`, `dirname(__FILE__) . '/x.php'` and `dirname(__DIR__, n) . '/x.php'`
 * give a spec starting with './' or '../' (relative to the including file); a bare literal is kept
 * as written. Anything computed is skipped.
 *
 * Declarations: `namespace` (every namespace the file declares), `classes` (classes, interfaces,
 * traits and enums, by short name), and `functions` and `consts` declared outside classes.
 */
export function scanPhp(text: string): ScanResult {
  const imports: ImportSpec[] = [];
  if (!text.includes('<?')) return { imports };
  const m = maskPhp(text);
  const namespaces = new Set<string>();
  const classes = new Set<string>();
  const functions = new Set<string>();
  const consts = new Set<string>();
  let depth = 0;          // brace depth
  let base = 0;           // depth of namespace-level statements: 1 inside `namespace X { … }`
  let classDepth = -1;    // depth inside the outermost open class body, -1 outside every class
  let classOpens = false; // a class header was read: the next `{` opens its body
  let pos = 0;            // cursor shared by the readers below

  /** Reads a qualified name at `pos`, after an optional `function` / `const`. No leading backslash. */
  const readName = (): string => {
    let j = skipSpace(m, pos);
    let e = nameEnd(m, j);
    const word = e - j === 8 || e - j === 5 ? m.slice(j, e).toLowerCase() : '';
    if ((word === 'function' || word === 'const') && isSpace(m.charCodeAt(e))) j = skipSpace(m, e);
    e = qualifiedEnd(m, j);
    pos = e;
    return m.charCodeAt(j) === 92 ? m.slice(j + 1, e) : m.slice(j, e);
  };
  /** Reads an optional `as Alias` at `pos`. */
  const readAlias = (): string => {
    const j = skipSpace(m, pos), e = nameEnd(m, j);
    if (e - j !== 2 || m.slice(j, e).toLowerCase() !== 'as') return '';
    const a = skipSpace(m, e), ae = nameEnd(m, a);
    if (ae === a) return '';
    pos = ae;
    return m.slice(a, ae);
  };
  const addUse = (spec: string, alias: string): void => {
    if (!spec || spec.charCodeAt(spec.length - 1) === 92) return;
    imports.push({ spec, kind: 'use', names: [alias || spec.slice(spec.lastIndexOf('\\') + 1)] });
  };
  /** Reads the clauses of a namespace-level `use` whose keyword ends at `pos`. */
  const readUse = (): void => {
    for (;;) {
      const name = readName();
      if (!name) return;
      let j = skipSpace(m, pos);
      if (m.charCodeAt(j) === 123 && name.charCodeAt(name.length - 1) === 92) { // use A\B\{C, D as E};
        pos = j + 1;
        for (;;) {
          const item = readName();
          if (!item) break;
          addUse(name + item, readAlias());
          j = skipSpace(m, pos);
          if (m.charCodeAt(j) !== 44) break;
          pos = j + 1;
        }
        j = skipSpace(m, pos);
        if (m.charCodeAt(j) === 125) pos = j + 1; // the group's own brace: consumed here, so never counted as a block
      } else addUse(name, readAlias());
      j = skipSpace(m, pos);
      if (m.charCodeAt(j) !== 44) return;
      pos = j + 1;
    }
  };

  /**
   * Reads `__DIR__`, `__FILE__` or `dirname(…[, n])` around either at `pos`. Returns how many
   * directory levels above the file itself it names (`__FILE__` 0, `__DIR__` 1), or -1.
   */
  const readDirLevels = (): number => {
    let j = pos;
    let opens = 0;
    for (;;) {
      if (m.charCodeAt(j) === 92) j++;
      if (!m.startsWith('dirname', j)) break;
      const k = skipSpace(m, j + 7);
      if (m.charCodeAt(k) !== 40) return -1;
      j = skipSpace(m, k + 1);
      opens++;
    }
    let levels: number;
    if (m.startsWith('__DIR__', j) && !isNameChar(m.charCodeAt(j + 7))) { levels = 1; j += 7; }
    else if (m.startsWith('__FILE__', j) && !isNameChar(m.charCodeAt(j + 8))) { levels = 0; j += 8; }
    else return -1;
    for (; opens > 0; opens--) {
      j = skipSpace(m, j);
      let by = 1;
      if (m.charCodeAt(j) === 44) {
        j = skipSpace(m, j + 1);
        let e = j;
        while (m.charCodeAt(e) >= 48 && m.charCodeAt(e) <= 57) e++;
        if (e === j || e - j > 3) return -1;
        by = Number(m.slice(j, e));
        j = skipSpace(m, e);
      }
      if (m.charCodeAt(j) !== 41) return -1;
      j++;
      levels += by;
      if (levels > MAX_DIR_LEVELS) return -1;
    }
    pos = j;
    return levels;
  };
  /** Reads the operand of a require / include whose keyword ends at `pos`. */
  const readInclude = (): void => {
    let j = skipSpace(m, pos);
    let parens = 0;
    while (m.charCodeAt(j) === 40) { parens++; j = skipSpace(m, j + 1); }
    pos = j;
    let up = -1;
    const levels = readDirLevels();
    if (levels === 0) return; // `__FILE__ . '…'` is not a path
    if (levels > 0) {
      up = levels - 1;
      j = skipSpace(m, pos);
      if (m.charCodeAt(j) !== 46) return;
      j = skipSpace(m, j + 1);
    }
    const q = m.charCodeAt(j);
    if (q !== 39 && q !== 34) return;
    let e = j + 1;
    while (m.charCodeAt(e) === FILL) e++;
    if (m.charCodeAt(e) !== q) return;
    let k = skipSpace(m, e + 1);
    while (parens > 0 && m.charCodeAt(k) === 41) { parens--; k = skipSpace(m, k + 1); }
    pos = k;
    if (m.charCodeAt(k) === 46) return; // more is concatenated after the literal: computed
    const spec = includeSpec(text.slice(j + 1, e), q === 34, up);
    if (spec) imports.push({ spec, kind: 'require' });
  };

  const token = /[{}]|\b(?:namespace|use|require_once|require|include_once|include|class|interface|trait|enum|function|const)\b/gi;
  let hit: RegExpExecArray | null;
  while ((hit = token.exec(m))) {
    const at = hit.index;
    const first = m.charCodeAt(at);
    if (first === 123) {
      depth++;
      if (classOpens) { classOpens = false; if (classDepth < 0) classDepth = depth; }
      continue;
    }
    if (first === 125) {
      if (depth > 0) depth--;
      if (depth < classDepth) classDepth = -1;
      if (depth < base) base = 0;
      continue;
    }
    // `$class`, `Foo\Use`, `->include(…)` and `Foo::class` are names, not keywords.
    const before = m.charCodeAt(at - 1);
    if (before === 36 || before === 92) continue;
    if ((before === 62 && m.charCodeAt(at - 2) === 45) || (before === 58 && m.charCodeAt(at - 2) === 58)) continue;

    const end = token.lastIndex;
    pos = end;
    const keyword = hit[0].toLowerCase();
    switch (keyword) {
      case 'namespace': {
        const j = skipSpace(m, end);
        if (m.charCodeAt(j) === 92) break; // the `namespace\name` operator
        const e = qualifiedEnd(m, j);
        const k = skipSpace(m, e);
        const next = m.charCodeAt(k);
        if (next === 59) base = depth;
        else if (next === 123) base = depth + 1; // `namespace A { … }`, or `namespace { … }` for the global one
        else break;
        if (e > j) namespaces.add(m.slice(j, e));
        pos = k;
        break;
      }
      case 'use':
        if (depth === base) readUse();
        break;
      case 'require': case 'require_once': case 'include': case 'include_once':
        readInclude();
        break;
      case 'class': case 'interface': case 'trait': case 'enum': {
        const j = skipSpace(m, end), e = nameEnd(m, j);
        const name = j > end && isNameStart(m.charCodeAt(j)) ? m.slice(j, e) : '';
        const lower = name.toLowerCase();
        if (!name || lower === 'extends' || lower === 'implements') {
          if (keyword === 'class') classOpens = true; // `new class { … }`
          break;
        }
        if (keyword === 'enum') { // a soft keyword: only `enum Name {`, `enum Name: type` and `enum Name implements` declare
          const k = skipSpace(m, e);
          const next = m.charCodeAt(k);
          if (next !== 123 && next !== 58 && m.slice(k, k + 10).toLowerCase() !== 'implements') break;
        }
        classes.add(name);
        classOpens = true;
        pos = e;
        break;
      }
      case 'function': {
        if (classDepth >= 0) break; // a method
        let j = skipSpace(m, end);
        if (m.charCodeAt(j) === 38) j = skipSpace(m, j + 1); // function &name()
        const e = nameEnd(m, j);
        if (e > j && isNameStart(m.charCodeAt(j))) { functions.add(m.slice(j, e)); pos = e; }
        break;
      }
      case 'const': {
        if (depth !== base) break; // a class constant
        // const A = 1, B = [2, 3];
        let j = skipSpace(m, end);
        let nesting = 0;
        for (;;) {
          const e = nameEnd(m, j);
          if (e === j || m.charCodeAt(skipSpace(m, e)) !== 61) break;
          consts.add(m.slice(j, e));
          let k = e;
          for (; k < m.length; k++) {
            const c = m.charCodeAt(k);
            if (c === 40 || c === 91) nesting++;
            else if (c === 41 || c === 93) nesting--;
            else if (c === 59 || c === 123 || c === 125 || (c === 44 && nesting === 0)) break;
          }
          pos = k;
          if (m.charCodeAt(k) !== 44) break;
          j = skipSpace(m, k + 1);
        }
        break;
      }
    }
    if (pos > token.lastIndex) token.lastIndex = pos;
  }

  const decls: Record<string, string[]> = {};
  if (namespaces.size) decls.namespace = [...namespaces];
  if (classes.size) decls.classes = [...classes];
  if (functions.size) decls.functions = [...functions];
  if (consts.size) decls.consts = [...consts];
  return Object.keys(decls).length ? { imports, decls } : { imports };
}
