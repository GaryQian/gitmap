// A tolerant tag finder for HTML-like text (HTML pages, Vue / Svelte / Astro components). It is not a
// parser: it finds the tags asked for, reads their attributes, and for <script> and <style> takes
// the raw text up to the closing tag. Comments are skipped, and whatever sits inside a script or
// style body is never looked at as markup.

export interface MarkupBlock {
  /** Tag name, lower case. */
  tag: string;
  /** Attributes by lower-case name; an attribute without a value maps to ''. */
  attrs: Record<string, string>;
  /** Raw contents of a <script> or <style> element; '' for any other tag. */
  body: string;
  /** Offset of the opening `<`. */
  start: number;
  /** Offset of `body` in the text. */
  bodyStart: number;
  /** Offset just after the element (after the closing tag of a script or style, else after the opening tag). */
  end: number;
}

const LT = 60, GT = 62, SLASH = 47, QUOTE = 34, APOS = 39, BACKTICK = 96, BACKSLASH = 92, NEWLINE = 10;
const isSpace = (c: number): boolean => c <= 32;
const isNameChar = (c: number): boolean =>
  (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 45 || c === 58 || c === 46 || c === 95;

/** True when a <script> with these attributes holds JavaScript or TypeScript (not JSON, a template, an import map). */
export function isScriptCode(attrs: Record<string, string>): boolean {
  const type = attrs.type;
  return !type || /module|javascript|ecmascript|babel|jsx|typescript|^ts$/i.test(type);
}

/** Reads attributes from `j` (just after the tag name) into `attrs`. Returns the index after the tag's `>`. */
function readAttrs(s: string, j: number, attrs: Record<string, string>): number {
  const n = s.length;
  for (;;) {
    while (j < n && isSpace(s.charCodeAt(j))) j++;
    if (j >= n) return n;
    let c = s.charCodeAt(j);
    if (c === GT) return j + 1;
    const nameStart = j;
    while (j < n && !isSpace((c = s.charCodeAt(j))) && c !== 61 && c !== GT && c !== SLASH && c !== QUOTE && c !== APOS) j++;
    if (j === nameStart) { j++; continue; } // a stray slash or quote
    const name = s.slice(nameStart, j).toLowerCase();
    while (j < n && isSpace(s.charCodeAt(j))) j++;
    let value = '';
    if (s.charCodeAt(j) === 61) {
      j++;
      while (j < n && isSpace(s.charCodeAt(j))) j++;
      c = s.charCodeAt(j);
      if (c === QUOTE || c === APOS) {
        const close = s.indexOf(s[j], j + 1);
        value = s.slice(j + 1, close < 0 ? n : close);
        j = close < 0 ? n : close + 1;
      } else if (c === 123) { // {expression}: Svelte and Astro
        const valueStart = j;
        let depth = 0;
        while (j < n) { const d = s.charCodeAt(j++); if (d === 123) depth++; else if (d === 125 && --depth === 0) break; }
        value = s.slice(valueStart, j);
      } else {
        const valueStart = j;
        while (j < n && !isSpace((c = s.charCodeAt(j))) && c !== GT) j++;
        value = s.slice(valueStart, j);
      }
    }
    if (!(name in attrs)) attrs[name] = value;
  }
}

/** True when `</tag` (any case) starts at `i`. */
function closesAt(s: string, i: number, tag: string): boolean {
  if (s.charCodeAt(i) !== LT || s.charCodeAt(i + 1) !== SLASH) return false;
  for (let k = 0; k < tag.length; k++) if ((s.charCodeAt(i + 2 + k) | 32) !== tag.charCodeAt(k)) return false;
  return !isNameChar(s.charCodeAt(i + 2 + tag.length));
}

/** Offset of the first `</tag` at or after `from`, or −1. */
function firstClose(s: string, from: number, tag: string): number {
  for (let i = s.indexOf('</', from); i >= 0; i = s.indexOf('</', i + 2)) if (closesAt(s, i, tag)) return i;
  return -1;
}

/**
 * Offset of the `</script` that ends a script body starting at `from`. One inside a string, a
 * template literal or a block comment does not count (browsers would end the script there; source
 * written for a bundler sometimes has it). When that reading finds no end — a regex literal holding
 * a quote can derail it — the first `</script` is taken, as a browser would.
 */
function scriptClose(s: string, from: number): number {
  const n = s.length;
  let i = from;
  scan: while (i < n) {
    const c = s.charCodeAt(i);
    if (c === LT) {
      if (closesAt(s, i, 'script')) return i;
      i++;
    } else if (c === SLASH) {
      const d = s.charCodeAt(i + 1);
      if (d === 42) {
        const e = s.indexOf('*/', i + 2);
        if (e < 0) break;
        i = e + 2;
      } else if (d === SLASH) { // a line comment still ends at a closing tag
        const e = s.indexOf('\n', i);
        const stop = e < 0 ? n : e;
        const close = s.slice(i, stop).search(/<\/script/i); // only this line is searched
        if (close >= 0) return i + close;
        i = stop;
      } else i++;
    } else if (c === QUOTE || c === APOS) {
      for (i++; i < n; i++) {
        const d = s.charCodeAt(i);
        if (d === BACKSLASH) i++;
        else if (d === c) { i++; break; }
        else if (d === NEWLINE) break;
      }
    } else if (c === BACKTICK) {
      for (i++; ; i++) {
        if (i >= n) break scan;
        const d = s.charCodeAt(i);
        if (d === BACKSLASH) i++;
        else if (d === BACKTICK) { i++; break; }
      }
    } else i++;
  }
  const close = firstClose(s, from, 'script');
  return close < 0 ? n : close;
}

/**
 * The elements of `text` whose tag is in `tags` (lower-case names), in document order. With
 * `anyCase`, tag names match in any case, as in HTML; without it only lower-case tags match, so that
 * a component named `<Link>` or `<Script>` is not taken for the HTML element.
 */
export function scanMarkup(text: string, tags: ReadonlySet<string>, anyCase = false): MarkupBlock[] {
  const out: MarkupBlock[] = [];
  const n = text.length;
  let i = 0;
  for (;;) {
    i = text.indexOf('<', i);
    if (i < 0) break;
    if (text.startsWith('!--', i + 1)) {
      const e = text.indexOf('-->', i + 4);
      if (e < 0) break;
      i = e + 3;
      continue;
    }
    let j = i + 1;
    while (j < n && isNameChar(text.charCodeAt(j))) j++;
    const raw = text.slice(i + 1, j);
    const tag = anyCase ? raw.toLowerCase() : raw;
    if (!tags.has(tag)) { i = j; continue; }
    const attrs: Record<string, string> = {};
    const open = readAttrs(text, j, attrs);
    const block: MarkupBlock = { tag, attrs, body: '', start: i, bodyStart: open, end: open };
    if ((tag === 'script' || tag === 'style') && text.charCodeAt(open - 2) !== SLASH) {
      const close = tag === 'script' && isScriptCode(attrs) ? scriptClose(text, open) : firstClose(text, open, tag);
      const bodyEnd = close < 0 ? n : close;
      block.body = text.slice(open, bodyEnd);
      const gt = text.indexOf('>', bodyEnd);
      block.end = bodyEnd >= n || gt < 0 ? n : gt + 1;
    }
    out.push(block);
    i = block.end;
  }
  return out;
}
