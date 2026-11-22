// Fast-pass scanner for Lua and Luau (PLAN.md §6.3). No syntax tree: comments and strings are
// blanked (./mask.ts) and the module loads are read from what is left.
//
// Import kinds:
//   'require'   require "a.b.c", require("a/b"), Luau's require("./sibling"), require("@alias/x")
//               — a literal string argument, as written;
//   'file'      dofile("scripts/x.lua"), loadfile("x.lua") — a literal path;
//   'instance'  Roblox's require(script.Parent.Util), require(ReplicatedStorage.Shared.Util),
//               require(script:WaitForChild("Util")) — the instance path joined with dots, the
//               WaitForChild / FindFirstChild / ["…"] steps written as plain segments.
// A require of anything else (a variable, a concatenation, a call) names nothing and is left out.
// `names` holds the local the module is assigned to (`local Util = require(…)` → ['Util']), which is
// what the file then qualifies the module's members with.
import type { ImportSpec, ScanResult } from '../../contracts/lang';
import { maskLua, stringAt } from './mask';

/** Most imports kept per file. */
const MAX_IMPORTS = 512;
/** How far back on its line the `local x =` in front of a require is looked for. */
const ASSIGN_WINDOW = 160;

const LOADER = /\b(require|dofile|loadfile)\b/g;
/** `local Name =`, `Name =`, `local Name: Type =` directly in front of the loader call. */
const ASSIGNED = /(?:^|[\s;])(?:local\s+)?([A-Za-z_]\w*)\s*(?::\s*[\w.<>, ]+?)?\s*=\s*$/;
const IDENT = /[A-Za-z_]\w*/y;
const CHILD_CALL = /\s*:\s*(?:WaitForChild|FindFirstChild)\s*\(\s*/y;

const LPAREN = 40, RPAREN = 41, DOT = 46, COLON = 58, QUOTE = 34, LBRACKET = 91, RBRACKET = 93;

function skipSpace(s: string, i: number): number {
  for (;;) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13) i++; else return i;
  }
}

/**
 * The instance path that starts at `i`: `script.Parent.Util`, `game:GetService("X").Y` is not one.
 * Returns its segments and the index past it, or null when what is there is not a plain path.
 */
function instancePath(text: string, m: string, i: number): { segments: string[]; end: number } | null {
  IDENT.lastIndex = i;
  const head = IDENT.exec(m);
  if (!head) return null;
  const segments = [head[0]];
  let j = IDENT.lastIndex;
  for (;;) {
    const k = skipSpace(m, j);
    const c = m.charCodeAt(k);
    if (c === DOT && m.charCodeAt(k + 1) !== DOT) {
      IDENT.lastIndex = skipSpace(m, k + 1);
      const seg = IDENT.exec(m);
      if (!seg) return null;
      segments.push(seg[0]);
      j = IDENT.lastIndex;
    } else if (c === LBRACKET) {
      const s = stringAt(text, m, skipSpace(m, k + 1));
      if (!s) return null;
      const close = skipSpace(m, s.end);
      if (m.charCodeAt(close) !== RBRACKET) return null;
      segments.push(s.value);
      j = close + 1;
    } else if (c === COLON) {
      CHILD_CALL.lastIndex = j;
      if (!CHILD_CALL.test(m)) return null;
      const s = stringAt(text, m, CHILD_CALL.lastIndex);
      if (!s) return null;
      // WaitForChild("X", timeout): anything up to the `)` on this line is an argument of the lookup.
      const close = m.indexOf(')', s.end);
      const eol = m.indexOf('\n', s.end);
      if (close < 0 || (eol >= 0 && eol < close)) return null;
      segments.push(s.value);
      j = close + 1;
    } else return { segments, end: j };
  }
}

/** Imports of a Lua or Luau source text. Never throws. */
export function scanLua(text: string): ScanResult {
  const imports: ImportSpec[] = [];
  try {
    const m = maskLua(text);
    LOADER.lastIndex = 0;
    let hit: RegExpExecArray | null;
    while ((hit = LOADER.exec(m)) && imports.length < MAX_IMPORTS) {
      const at = hit.index;
      const before = m.charCodeAt(at - 1);
      if (before === DOT || before === COLON) continue; // `loader.require(…)`: someone else's function

      let i = skipSpace(m, at + hit[0].length);
      const paren = m.charCodeAt(i) === LPAREN;
      if (paren) i = skipSpace(m, i + 1);

      let spec = '', kind = '', end = i;
      if (m.charCodeAt(i) === QUOTE) {
        const s = stringAt(text, m, i);
        if (!s || !s.value.trim()) continue;
        spec = s.value.trim();
        kind = hit[1] === 'require' ? 'require' : 'file';
        end = s.end;
      } else if (hit[1] === 'require' && paren) {
        const p = instancePath(text, m, i);
        if (!p || p.segments.length < 2) continue;
        spec = p.segments.join('.');
        kind = 'instance';
        end = p.end;
      } else continue;
      // The argument is the whole of it: `require("a" .. b)` and `require(x.y(z))` name nothing.
      if (paren && m.charCodeAt(skipSpace(m, end)) !== RPAREN) continue;

      const lineStart = m.lastIndexOf('\n', at - 1) + 1;
      const assigned = ASSIGNED.exec(m.slice(Math.max(lineStart, at - ASSIGN_WINDOW), at));
      imports.push(assigned ? { spec, kind, names: [assigned[1]] } : { spec, kind });
      LOADER.lastIndex = end;
    }
  } catch { /* keep what was read: scan must never throw */ }
  return { imports };
}
