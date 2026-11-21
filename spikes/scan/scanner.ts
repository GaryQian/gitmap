// Fast-pass scanner: line count + import specifiers, no syntax tree.
// One pass blanks comments (keeping strings), then per-language regexes find imports.
export type Lang = 'ts' | 'js' | 'py' | 'c' | 'cpp' | 'objc' | 'java' | 'kotlin' | 'cs' | 'go' | 'rust' | 'dart' | 'swift';

const EXT: Record<string, Lang> = {
  ts: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
  py: 'py', pyi: 'py', c: 'c', h: 'cpp', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hh: 'cpp', hpp: 'cpp', hxx: 'cpp',
  m: 'objc', mm: 'objc', java: 'java', kt: 'kotlin', kts: 'kotlin', cs: 'cs', go: 'go', rs: 'rust',
  dart: 'dart', swift: 'swift',
};
export function langOf(path: string): Lang | null {
  const dot = path.lastIndexOf('.');
  return dot < 0 ? null : EXT[path.slice(dot + 1).toLowerCase()] ?? null;
}

// Blank comments in place (replace with spaces, keep newlines). Strings are kept intact.
function blankComments(s: string, hash: boolean): string {
  const out = s.split('');
  const n = s.length;
  let i = 0;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 47 /* / */ && !hash) {
      const d = s.charCodeAt(i + 1);
      if (d === 47) { while (i < n && s.charCodeAt(i) !== 10) out[i++] = ' '; continue; }
      if (d === 42) { out[i] = out[i + 1] = ' '; i += 2;
        while (i < n && !(s.charCodeAt(i) === 42 && s.charCodeAt(i + 1) === 47)) { if (s.charCodeAt(i) !== 10) out[i] = ' '; i++; }
        if (i < n) { out[i] = out[i + 1] = ' '; i += 2; } continue; }
    } else if (c === 35 /* # */ && hash) {
      while (i < n && s.charCodeAt(i) !== 10) out[i++] = ' '; continue;
    } else if (c === 34 || c === 39 || c === 96) { // skip string literal
      const q = c; i++;
      if (hash && s.charCodeAt(i) === q && s.charCodeAt(i + 1) === q) { // python triple quote
        i += 2; while (i < n && !(s.charCodeAt(i) === q && s.charCodeAt(i + 1) === q && s.charCodeAt(i + 2) === q)) i++; i += 3; continue;
      }
      while (i < n) { const e = s.charCodeAt(i); if (e === 92) { i += 2; continue; } if (e === q || (e === 10 && q !== 96)) break; i++; }
      i++; continue;
    }
    i++;
  }
  return out.join('');
}

const RX: Record<Lang, RegExp[]> = {
  ts: [/\bimport\s+(?:type\s+)?(?:[\w*{}\s,]+\s+from\s+)?['"]([^'"]+)['"]/g, /\bexport\s+[\w*{}\s,]*\s+from\s+['"]([^'"]+)['"]/g, /\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g],
  js: [], py: [/^\s*from\s+([\w.]+)\s+import\b/gm, /^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/gm],
  c: [/^\s*#\s*include\s*[<"]([^>"]+)[>"]/gm], cpp: [], objc: [/^\s*#\s*(?:include|import)\s*[<"]([^>"]+)[>"]/gm, /^\s*@import\s+([\w.]+)/gm],
  java: [/^\s*import\s+(?:static\s+)?([\w.*]+)\s*;/gm], kotlin: [/^\s*import\s+([\w.*`]+)/gm],
  cs: [/^\s*(?:global\s+)?using\s+(?:static\s+)?(?:\w+\s*=\s*)?([\w.]+)\s*;/gm],
  go: [/^\s*import\s+(?:\w+\s+)?"([^"]+)"/gm, /^\s*(?:\w+\s+|\.\s+|_\s+)?"([^"]+)"\s*$/gm],
  rust: [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:use|mod)\s+([\w:]+)/gm], dart: [/^\s*(?:import|export|part)\s+['"]([^'"]+)['"]/gm],
  swift: [/^\s*(?:@\w+\s+)*import\s+(?:\w+\s+)?([\w.]+)/gm],
};
RX.js = RX.ts; RX.cpp = RX.c;
const HASH: Partial<Record<Lang, boolean>> = { py: true };

export interface ScanResult { loc: number; imports: string[] }
export function scan(text: string, lang: Lang): ScanResult {
  let loc = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) loc++;
  if (text.length && text.charCodeAt(text.length - 1) !== 10) loc++;
  const clean = blankComments(text, !!HASH[lang]);
  const imports: string[] = [];
  for (const rx of RX[lang]) { rx.lastIndex = 0; let m; while ((m = rx.exec(clean))) imports.push(m[1]); }
  return { loc, imports };
}
