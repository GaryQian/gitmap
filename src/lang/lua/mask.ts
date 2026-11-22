// Comment and string blanking for Lua and Luau, shared by the fast-pass scanner and the slow-pass
// extractor. The result has the same length and the same line breaks as the input:
//   - comments (`-- …`, `--[[ … ]]`, `--[==[ … ]==]`, a leading `#!` line) become spaces;
//   - every string keeps its place but loses its content: its first and last character become `"`
//     and everything between becomes spaces. That holds for '…', "…", Luau's `…` and long strings
//     (`[[ … ]]`, `[=[ … ]=]`), so later steps see one kind of string and read its text, when they
//     need it, from the original at the same offsets (stringAt).
// One left-to-right sweep; every character is looked at a bounded number of times.

const NL = 10, QUOTE = 34, APOS = 39, MINUS = 45, EQUALS = 61, LBRACKET = 91, BACKSLASH = 92, BACKTICK = 96;

/** Level of the long bracket opening at `i` (`[[` is 0, `[==[` is 2), or -1 when there is none. */
function longLevel(s: string, i: number): number {
  let j = i + 1;
  while (s.charCodeAt(j) === EQUALS) j++;
  return s.charCodeAt(j) === LBRACKET ? j - i - 1 : -1;
}

/** Index past the `]=*]` that closes a long bracket of `level` whose content starts at `from`. */
function longEnd(s: string, from: number, level: number): number {
  const close = s.indexOf(`]${'='.repeat(level)}]`, from);
  return close < 0 ? s.length : close + level + 2;
}

/** Index past the closing quote of the string opening at `i`, or of the line break that leaves it open. */
function quotedEnd(s: string, i: number, quote: number): number {
  const n = s.length;
  for (let j = i + 1; j < n; j++) {
    const c = s.charCodeAt(j);
    if (c === BACKSLASH) {
      j++;
      if (s.charCodeAt(j) === 122) while (j + 1 < n && /\s/.test(s[j + 1])) j++; // `\z` skips the white space after it
    } else if (c === quote) return j + 1;
    else if (c === NL) return j;
  }
  return n;
}

export function maskLua(text: string): string {
  const n = text.length;
  const out: string[] = [];
  let last = 0;
  const blank = (from: number, to: number, string: boolean): void => {
    out.push(text.slice(last, from));
    const spaces = text.slice(from, to).replace(/[^\n]/g, ' ');
    out.push(string && to - from >= 2 ? `"${spaces.slice(1, -1)}"` : spaces);
    last = to;
  };

  let i = 0;
  if (text.charCodeAt(0) === 35) { // '#': a shebang line
    const eol = text.indexOf('\n');
    i = eol < 0 ? n : eol;
    blank(0, i, false);
  }
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === MINUS && text.charCodeAt(i + 1) === MINUS) {
      const level = text.charCodeAt(i + 2) === LBRACKET ? longLevel(text, i + 2) : -1;
      let end: number;
      if (level >= 0) end = longEnd(text, i + level + 4, level);
      else { end = text.indexOf('\n', i); if (end < 0) end = n; }
      blank(i, end, false);
      i = end;
    } else if (c === QUOTE || c === APOS || c === BACKTICK) {
      const end = quotedEnd(text, i, c);
      blank(i, end, true);
      i = end;
    } else if (c === LBRACKET && longLevel(text, i) >= 0) {
      const level = longLevel(text, i);
      const end = longEnd(text, i + level + 2, level);
      blank(i, end, true);
      i = end;
    } else i++;
  }
  out.push(text.slice(last));
  return out.join('');
}

/**
 * The string that opens at `i` (where the mask has a `"`): its text as written, with no escape
 * processing, and the index past it. Null for a string with escapes or Luau interpolation, whose
 * value is not its source text.
 */
export function stringAt(text: string, masked: string, i: number): { value: string; end: number } | null {
  if (masked.charCodeAt(i) !== QUOTE) return null;
  const close = masked.indexOf('"', i + 1);
  if (close < 0) return null;
  const open = text.charCodeAt(i);
  let value: string;
  if (open === LBRACKET) {
    const level = longLevel(text, i);
    value = text.slice(i + level + 2, close - level - 1);
  } else {
    value = text.slice(i + 1, close);
    if (text.charCodeAt(close) !== open || value.includes('\\') || (open === BACKTICK && value.includes('{'))) return null;
  }
  return { value, end: close + 1 };
}
