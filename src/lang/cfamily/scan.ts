// Fast-pass include scanner shared by the C-family plug-ins (PLAN.md §6.3). No syntax tree.
// Comments are blanked first (string literals are stepped over so a "//" inside one is not a
// comment), then one line-anchored pattern finds the include directives.
import type { ImportSpec, ScanResult } from '../../contracts/lang';

/** Same-length copy of `s` with // and block comments replaced by spaces; newlines stay. */
export function blankComments(s: string): string {
  if (s.indexOf('/') < 0) return s;
  const n = s.length;
  const parts: string[] = [];
  let from = 0;
  let i = 0;
  // Replaces [a, b) by spaces, keeping its newlines so line starts are preserved.
  const blank = (a: number, b: number) => {
    parts.push(s.slice(from, a));
    let lineStart = a;
    for (let k = a; k < b; k++) {
      if (s.charCodeAt(k) === 10) { parts.push(' '.repeat(k - lineStart), '\n'); lineStart = k + 1; }
    }
    parts.push(' '.repeat(b - lineStart));
    from = b;
  };
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 47) {
      const d = s.charCodeAt(i + 1);
      if (d === 47) {
        const a = i;
        while (i < n && s.charCodeAt(i) !== 10) { if (s.charCodeAt(i) === 92 && s.charCodeAt(i + 1) === 10) i++; i++; }
        blank(a, Math.min(i, n));
        continue;
      }
      if (d === 42) {
        const a = i;
        i += 2;
        while (i < n && !(s.charCodeAt(i) === 42 && s.charCodeAt(i + 1) === 47)) i++;
        i = Math.min(n, i + 2);
        blank(a, i);
        continue;
      }
    } else if (c === 34 || c === 39) { // string or character literal; ends at the line end if unterminated
      i++;
      while (i < n) {
        const e = s.charCodeAt(i);
        if (e === 92) { i += 2; continue; }
        if (e === c || e === 10) break;
        i++;
      }
    }
    i++;
  }
  if (from === 0) return s;
  parts.push(s.slice(from));
  return parts.join('');
}

const ANY_DIRECTIVE = /#[ \t]*(?:include|import)/;

/**
 * `#include "x"` (kind 'include') and `#include <x>` (kind 'include-system'). `#import` (Objective-C,
 * and Objective-C headers that end in .h) is read the same way.
 */
export function scanIncludes(text: string): ScanResult {
  const imports: ImportSpec[] = [];
  if (!ANY_DIRECTIVE.test(text)) return { imports };
  const clean = blankComments(text);
  const directive = /^[ \t]*#[ \t]*(?:include|import)[ \t]*(?:"([^"\n]+)"|<([^>\n]+)>)/gm;
  let m: RegExpExecArray | null;
  while ((m = directive.exec(clean))) {
    if (m[1] !== undefined) imports.push({ spec: m[1], kind: 'include' });
    else imports.push({ spec: m[2], kind: 'include-system' });
  }
  return { imports };
}
