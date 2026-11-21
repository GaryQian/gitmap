// Tolerant JSON for tsconfig.json / jsconfig.json / package.json: comments and trailing commas are allowed.

/** Parsed value, or undefined when the text is not JSON even after removing comments and trailing commas. */
export function parseJsonc(text: string): unknown {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try { return JSON.parse(text); } catch { /* fall through to the tolerant path */ }
  try { return JSON.parse(stripJsonc(text)); } catch { return undefined; }
}

/** Removes // and block comments and commas that directly precede a closing bracket, outside strings. */
export function stripJsonc(text: string): string {
  const n = text.length;
  const parts: string[] = [];
  let from = 0; // start of the pending run of text to keep
  let i = 0;
  /** Index in `parts` of the last comma kept, while nothing but whitespace and comments has followed it. */
  let pendingComma = -1;
  const flush = (to: number) => { if (to > from) parts.push(text.slice(from, to)); };
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 34) { // string: copy through
      pendingComma = -1;
      i++;
      while (i < n) {
        const d = text.charCodeAt(i);
        if (d === 92) { i += 2; continue; }
        i++;
        if (d === 34) break;
      }
      continue;
    }
    if (c === 47 && text.charCodeAt(i + 1) === 47) {
      flush(i);
      while (i < n && text.charCodeAt(i) !== 10) i++;
      from = i;
      continue;
    }
    if (c === 47 && text.charCodeAt(i + 1) === 42) {
      flush(i);
      i += 2;
      while (i < n && !(text.charCodeAt(i) === 42 && text.charCodeAt(i + 1) === 47)) i++;
      i = Math.min(n, i + 2);
      from = i;
      continue;
    }
    if (c === 44) {
      flush(i);
      pendingComma = parts.length;
      parts.push(',');
      from = ++i;
      continue;
    }
    if (c === 125 || c === 93) {
      if (pendingComma >= 0) parts[pendingComma] = '';
      pendingComma = -1;
    } else if (c > 32) pendingComma = -1;
    i++;
  }
  flush(n);
  return parts.join('');
}
