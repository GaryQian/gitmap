// Native (C / C++ / Objective-C++) side of the JNI bridge (PLAN.md §6.4.1).
//
//   provides  jni:<class>#<method>   a function *defined* under its mangled name Java_<class>_<method>,
//                                    or a JNINativeMethod table entry registered for <class>
//   consumes  jvm:<class>            FindClass("com/foo/Bar")
//             jvm:<class>#<method>   …refined by GetMethodID / GetStaticMethodID on that class
//
// No syntax tree: comments and literal contents are masked, then a few bounded pattern scans run
// over the masked text. Every scan looks a fixed distance ahead, so the whole is linear.
import { demangleJni } from './jni';
import { literalAt, maskCode, matchParen } from './mask';
import type { KeySink } from './types';

/** Longest parameter list of a Java_ function that is followed to its body. */
const PARAMS_WINDOW = 1000;
/** Longest argument list read from a JNI call. */
const CALL_WINDOW = 400;
/** How far back from a call its assignment target is looked for. */
const STATEMENT_WINDOW = 200;

const CLASS_PATH = /^[A-Za-z_$][\w$]*(?:[/.][A-Za-z_$][\w$]*)*$/;
const MEMBER_NAME = /^(?:[A-Za-z_$][\w$]*|<init>)$/;

/** 'com/foo/Bar' (or 'Lcom/foo/Bar;') → 'com.foo.Bar'; null for arrays and anything that is not a class path. */
function normaliseClass(literal: string): string | null {
  let v = literal;
  if (v.length > 300) return null;
  if (v.charCodeAt(0) === 76 && v.charCodeAt(v.length - 1) === 59 && v.indexOf('/') > 0) v = v.slice(1, -1);
  return CLASS_PATH.test(v) ? v.replace(/\//g, '.') : null;
}

interface Span { a: number; b: number }
interface ClassAt { pos: number; cls: string }

/** Top-level argument spans of the call whose parentheses are at `open` and `close`. */
function splitArgs(code: string, open: number, close: number): Span[] {
  const out: Span[] = [];
  let depth = 0;
  let a = open + 1;
  for (let i = open + 1; i < close; i++) {
    const c = code.charCodeAt(i);
    if (c === 40 || c === 91 || c === 123) depth++;
    else if (c === 41 || c === 93 || c === 125) depth--;
    else if (c === 44 && depth === 0) { out.push({ a, b: i }); a = i + 1; }
  }
  out.push({ a, b: close });
  return out;
}

/** The variable a call at `pos` is assigned to (`x = …call(` or `Type x(…call(`), if any. */
function assignmentTarget(code: string, pos: number): string | undefined {
  let seg = code.slice(Math.max(0, pos - STATEMENT_WINDOW), pos);
  const cut = Math.max(seg.lastIndexOf(';'), seg.lastIndexOf('{'), seg.lastIndexOf('}'));
  seg = seg.slice(cut + 1);
  const assign = /([A-Za-z_]\w*)\s*(?:\[[^\]]*\]\s*)?=(?!=)/.exec(seg);
  if (assign) return assign[1];
  const construct = /^[\s\w:<>*&]*?[\w>*&]\s+([A-Za-z_]\w*)\s*[({]/.exec(seg);
  return construct ? construct[1] : undefined;
}

export function extractNative(text: string, out: KeySink): void {
  const hasMangled = text.indexOf('Java_') >= 0;
  const hasFindClass = text.indexOf('FindClass') >= 0;
  const hasTable = text.indexOf('JNINativeMethod') >= 0;
  if (!hasMangled && !hasFindClass && !hasTable) return;
  const code = maskCode(text, { rawStrings: true });
  let m: RegExpExecArray | null;

  // ---- functions defined under a mangled name ----
  if (hasMangled) {
    const mangled = /\bJava_\w+/g;
    while ((m = mangled.exec(code))) {
      let p = mangled.lastIndex;
      while (p < code.length && code.charCodeAt(p) <= 32) p++;
      if (code.charCodeAt(p) !== 40) continue; // a reference, not a declarator
      const close = matchParen(code, p, PARAMS_WINDOW);
      if (close < 0) { mangled.lastIndex = p + PARAMS_WINDOW; continue; } // unbalanced: do not rescan the window
      mangled.lastIndex = close + 1;
      // A body makes it a definition. A prototype (in a javah-style header, say) is not a provider:
      // header and implementation would otherwise both provide the key and cancel each other out.
      const tail = code.slice(close + 1, close + 81);
      const k = tail.search(/[{;,)=]/);
      if (k < 0 || tail[k] !== '{') continue;
      const name = demangleJni(m[0]);
      if (name) out.provides.add(`jni:${name.className}#${name.method}`);
    }
  }
  if (!hasFindClass && !hasTable) return;

  // ---- string constants that hold a class path: `kClassName = "com/foo/Bar"`, `#define CLS "com/foo/Bar"` ----
  let constants: Map<string, string> | undefined;
  const constantClass = (name: string): string | undefined => {
    if (!constants) {
      constants = new Map();
      const patterns = [/\b([A-Za-z_]\w*)\s*(?:\[\s*\w*\s*\]\s*)?=\s*"/g, /#[ \t]*define[ \t]+([A-Za-z_]\w*)[ \t]+"/g];
      for (const re of patterns) {
        let c: RegExpExecArray | null;
        while ((c = re.exec(code))) {
          const lit = literalAt(code, text, re.lastIndex - 1);
          const cls = lit && lit.value.indexOf('/') > 0 ? normaliseClass(lit.value) : null;
          if (cls && !constants.has(c[1])) constants.set(c[1], cls);
        }
      }
    }
    return constants.get(name);
  };

  // ---- class variables: which class a jclass variable holds, by position in the text ----
  const assigned = new Map<string, ClassAt[]>();
  const assign = (name: string | undefined, pos: number, cls: string) => {
    if (!name) return;
    const list = assigned.get(name);
    if (list) list.push({ pos, cls }); else assigned.set(name, [{ pos, cls }]);
  };
  /** The class `name` holds at `pos`: its latest assignment before `pos`, else its only class. */
  const classOfVar = (name: string, pos: number): string | undefined => {
    const list = assigned.get(name);
    if (!list) return undefined;
    let lo = 0;
    let hi = list.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid].pos <= pos) lo = mid + 1; else hi = mid; }
    if (lo > 0) return list[lo - 1].cls;
    for (const a of list) if (a.cls !== list[0].cls) return undefined;
    return list[0].cls;
  };
  /** First identifier in [a, b) that names a known class variable or class-path constant. */
  const classOfExpr = (a: number, b: number, pos: number, allowConstants: boolean): string | undefined => {
    const ident = /[A-Za-z_]\w*/g;
    const seg = code.slice(a, b);
    let id: RegExpExecArray | null;
    while ((id = ident.exec(seg))) {
      const cls = classOfVar(id[0], pos) ?? (allowConstants ? constantClass(id[0]) : undefined);
      if (cls) return cls;
    }
    return undefined;
  };
  /** The class named by the first string literal in [a, b), if it is a class path. */
  const classLiteral = (a: number, b: number): string | undefined => {
    const q = code.slice(a, b).indexOf('"');
    const lit = q < 0 ? null : literalAt(code, text, a + q);
    return (lit && normaliseClass(lit.value)) ?? undefined;
  };

  // ---- FindClass("com/foo/Bar") ----
  const finds: ClassAt[] = [];
  if (hasFindClass) {
    const find = /FindClass\w*\s*\(/g;
    while ((m = find.exec(code))) {
      const open = find.lastIndex - 1;
      const close = matchParen(code, open, CALL_WINDOW);
      if (close < 0) continue;
      const cls = classLiteral(open + 1, close) ?? classOfExpr(open + 1, close, m.index, true);
      if (!cls) continue;
      finds.push({ pos: m.index, cls });
      assign(assignmentTarget(code, m.index), m.index, cls);
    }
    // `gClass = (jclass) env->NewGlobalRef(localClass)` carries the class to a second variable.
    if (finds.length > 0 && text.indexOf('NewGlobalRef') >= 0) {
      const aliases: { name: string; pos: number; cls: string }[] = [];
      const ref = /NewGlobalRef\s*\(/g;
      while ((m = ref.exec(code))) {
        const open = ref.lastIndex - 1;
        const close = matchParen(code, open, CALL_WINDOW);
        if (close < 0) continue;
        const cls = classOfExpr(open + 1, close, m.index, false);
        const name = cls ? assignmentTarget(code, m.index) : undefined;
        if (cls && name) aliases.push({ name, pos: m.index, cls });
      }
      for (const a of aliases) assign(a.name, a.pos, a.cls);
      if (aliases.length > 0) for (const list of assigned.values()) list.sort((x, y) => x.pos - y.pos);
    }
  }
  /** The FindClass call that starts inside [a, b), if any (`finds` is in text order). */
  const findInside = (a: number, b: number): string | undefined => {
    let lo = 0;
    let hi = finds.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (finds[mid].pos < a) lo = mid + 1; else hi = mid; }
    return lo < finds.length && finds[lo].pos < b ? finds[lo].cls : undefined;
  };

  // ---- GetMethodID(cls, "name", "sig") / GetStaticMethodID: method-level keys ----
  const refined = new Set<string>();
  const methodKeys: string[] = [];
  if (finds.length > 0 && text.indexOf('MethodID') >= 0) {
    const get = /Get(?:Static)?MethodID\w*\s*\(/g;
    while ((m = get.exec(code))) {
      const open = get.lastIndex - 1;
      const close = matchParen(code, open, CALL_WINDOW);
      if (close < 0) continue;
      const args = splitArgs(code, open, close);
      // The method name is the first argument that is a string; the class is the argument before it.
      for (let k = 1; k < args.length; k++) {
        let q = args[k].a;
        while (q < args[k].b && code.charCodeAt(q) <= 32) q++;
        const lit = literalAt(code, text, q);
        if (!lit) continue;
        const cls = findInside(args[k - 1].a, args[k - 1].b) ?? classOfExpr(args[k - 1].a, args[k - 1].b, m.index, false);
        if (cls && MEMBER_NAME.test(lit.value)) { methodKeys.push(`jvm:${cls}#${lit.value}`); refined.add(cls); }
        break;
      }
    }
  }

  // ---- RegisterNatives: JNINativeMethod tables and the class each is registered for ----
  const registered = new Set<string>();
  if (hasTable) {
    const tables = new Map<string, string[]>();
    const decl = /\bJNINativeMethod\b/g;
    while ((m = decl.exec(code))) {
      // `JNINativeMethod name[] = {` — the declarator runs to the brace; a parameter or a sizeof does not reach one.
      const head = code.slice(decl.lastIndex, decl.lastIndex + 200);
      const stop = head.search(/[{;()]/);
      if (stop < 0 || head[stop] !== '{') continue;
      const nm = /([A-Za-z_]\w*)\s*(?:\[[^\]]*\]\s*)*=?\s*$/.exec(head.slice(0, stop));
      if (!nm) continue;
      // Each entry is a brace group whose first string is the Java method name.
      const methods: string[] = [];
      let depth = 0;
      let fresh = false;
      let i = decl.lastIndex + stop;
      for (; i < code.length; i++) {
        const c = code.charCodeAt(i);
        if (c === 123) { depth++; fresh = true; }
        else if (c === 125) { if (--depth === 0) break; fresh = false; }
        else if (c === 34) {
          const lit = literalAt(code, text, i);
          if (!lit) { fresh = false; continue; }
          if (fresh && depth >= 2 && MEMBER_NAME.test(lit.value)) methods.push(lit.value);
          fresh = false;
          i = lit.end;
        }
      }
      decl.lastIndex = i;
      if (methods.length > 0 && !tables.has(nm[1])) tables.set(nm[1], methods);
    }

    if (tables.size > 0) {
      const classOfTable = new Map<string, Set<string>>();
      // RegisterNatives(cls, table, n) and the common wrappers that take the class path as a string
      // (jniRegisterNativeMethods, AndroidRuntime::registerNativeMethods).
      const register = /[Rr]egisterNative(?:s|Methods)\w*\s*\(/g;
      while ((m = register.exec(code))) {
        const open = register.lastIndex - 1;
        const close = matchParen(code, open, CALL_WINDOW);
        if (close < 0) continue;
        let table: string | undefined;
        const ident = /[A-Za-z_]\w*/g;
        const seg = code.slice(open + 1, close);
        let id: RegExpExecArray | null;
        while ((id = ident.exec(seg))) if (tables.has(id[0])) { table = id[0]; break; }
        if (!table) continue;
        const cls = classLiteral(open + 1, close) ?? classOfExpr(open + 1, close, m.index, true);
        if (!cls) continue;
        const set = classOfTable.get(table);
        if (set) set.add(cls); else classOfTable.set(table, new Set([cls]));
      }
      // A table no call accounts for belongs to the file's one FindClass, when there is exactly one.
      const distinct = new Set(finds.map((f) => f.cls));
      const only = distinct.size === 1 ? finds[0].cls : undefined;
      for (const [table, methods] of tables) {
        const classes = classOfTable.get(table) ?? (only ? new Set([only]) : undefined);
        if (!classes) continue;
        for (const cls of classes) {
          registered.add(cls);
          for (const name of methods) out.provides.add(`jni:${cls}#${name}`);
        }
      }
    }
  }

  // ---- consumed JVM classes ----
  // A class looked up only to register natives for it is not a call back into the JVM, and a
  // class with method-level keys needs no bare class key (they fall back to it in the linker).
  for (const f of finds) if (!refined.has(f.cls) && !registered.has(f.cls)) out.consumes.add('jvm:' + f.cls);
  for (const key of methodKeys) out.consumes.add(key);
}
