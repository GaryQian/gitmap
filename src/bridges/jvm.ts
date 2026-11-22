// JVM side of the JNI bridge (PLAN.md §6.4.1): Java `native` methods and Kotlin `external fun`
// consume `jni:<class>#<method>`; every top-level and nested class a Java, Kotlin or Scala file
// declares provides `jvm:<class>`. Class names are JVM binary names: dotted package, `$` before a
// nested class (`com.foo.Outer$Inner`), which is what JNI name mangling and FindClass both use.
//
// No syntax tree: comments and literals are masked, then one token sweep tracks braces and
// class headers. Linear in the text.
import { basename } from '../shared';
import { literalAt, maskCode } from './mask';
import type { KeySink } from './types';

export type JvmLang = 'java' | 'kotlin' | 'scala';

interface Scope {
  /** 'class': a class body. 'pkg': a Scala `package x { }` block. 'other': a method body, lambda, initialiser… */
  kind: 'class' | 'pkg' | 'other';
  /** Binary name, for kind 'class'. */
  name: string;
  /** For a Kotlin companion object: the binary name of the class it belongs to. */
  companionOf?: string;
  /** For kind 'pkg': the package to return to when the block closes. */
  restorePkg?: string;
}

const TOKEN = /[{}();=]|@JvmStatic\b|\b(?:package|class|interface|enum|record|object|trait|companion|native|external|fun|val|var|def)\b/g;
const CLASS_KEYWORDS: Record<JvmLang, ReadonlySet<string>> = {
  java: new Set(['class', 'interface', 'enum', 'record']),
  kotlin: new Set(['class', 'interface', 'object']),
  scala: new Set(['class', 'trait', 'object', 'enum']),
};
/** How far past `native` / `fun` the method's opening parenthesis may be. */
const HEADER_WINDOW = 400;

export function extractJvm(path: string, lang: JvmLang, text: string, out: KeySink): void {
  const code = maskCode(text, { tripleQuotes: true, nestedComments: lang !== 'java' });
  const classKeywords = CLASS_KEYWORDS[lang];
  const token = new RegExp(TOKEN.source, 'g');
  const nameAfter = /[ \t]+([A-Za-z_$][\w$]*)/y;
  const qualifiedAfter = /[ \t]+([A-Za-z_][\w.]*)/y;
  const recordHeader = /\s*[(<]/y;
  const funInterface = /[ \t]+interface\b/y;

  let pkg = '';
  const scopes: Scope[] = [];
  /** A class header whose body brace has not been seen yet. */
  let pending: { name: string; paren: number; companionOf?: string } | null = null;
  /** Set for exactly one token after a Scala `package x`: the package before it. */
  let packageJustSeen: string | null = null;
  let paren = 0;
  // Kotlin modifiers waiting for their `fun`; the value is the parenthesis depth they were seen at.
  let externalAt = -1;
  let jvmStaticAt = -1;
  let companion = false;
  let topLevelMembers = false;

  const top = (): Scope | undefined => scopes[scopes.length - 1];
  const clearModifiers = () => { externalAt = -1; jvmStaticAt = -1; };

  let facade: string | null | undefined;
  /** Binary name of the class Kotlin compiles this file's top-level declarations into, or null. */
  const fileFacade = (): string | null => {
    if (facade !== undefined) return facade;
    let name = '';
    const ann = /@file\s*:\s*(?:\[\s*)?JvmName\s*\(\s*"/.exec(code);
    const lit = ann ? literalAt(code, text, ann.index + ann[0].length - 1) : null;
    if (lit && /^[A-Za-z_$][\w$]*$/.test(lit.value)) {
      name = lit.value;
    } else {
      const base = basename(path);
      if (base.toLowerCase().endsWith('.kt')) {
        const stem = base.slice(0, -3).replace(/[^\w$]/g, '_');
        if (stem) name = stem[0].toUpperCase() + stem.slice(1) + 'Kt';
      }
    }
    facade = name ? (pkg ? pkg + '.' + name : name) : null;
    return facade;
  };

  /** Name of the method whose parameter list opens after `from`: the identifier before the first `(`. */
  const methodNameAfter = (from: number): string | null => {
    const window = code.slice(from, from + HEADER_WINDOW);
    const open = window.indexOf('(');
    if (open < 0) return null;
    const head = window.slice(0, open);
    if (/[{};=]/.test(head)) return null;
    const m = /(?:`([^`\n]+)`|([A-Za-z_$][\w$]*))\s*$/.exec(head);
    return m ? (m[1] ?? m[2]) : null;
  };

  let m: RegExpExecArray | null;
  while ((m = token.exec(code))) {
    const tok = m[0];
    const end = token.lastIndex;
    const afterPackage = packageJustSeen;
    packageJustSeen = null;

    switch (tok) {
      case '(': paren++; break;
      case ')': if (paren > 0) paren--; break;
      case '{':
        if (pending && paren === pending.paren) {
          scopes.push({ kind: 'class', name: pending.name, companionOf: pending.companionOf });
          pending = null;
        } else if (afterPackage !== null) {
          scopes.push({ kind: 'pkg', name: '', restorePkg: afterPackage });
        } else {
          scopes.push({ kind: 'other', name: '' });
        }
        clearModifiers();
        companion = false;
        break;
      case '}': {
        const closed = scopes.pop();
        if (closed && closed.restorePkg !== undefined) pkg = closed.restorePkg;
        pending = null;
        clearModifiers();
        companion = false;
        break;
      }
      case ';':
      case '=':
        if (pending && paren === pending.paren) pending = null;
        if (externalAt === paren) externalAt = -1;
        if (jvmStaticAt === paren) jvmStaticAt = -1;
        break;
      case 'package': {
        if (scopes.some((s) => s.kind !== 'pkg')) break;
        qualifiedAfter.lastIndex = end;
        const q = qualifiedAfter.exec(code);
        if (!q || q[1] === 'object') break; // Scala `package object x` is an object
        if (lang === 'scala') {
          packageJustSeen = pkg;
          pkg = pkg ? pkg + '.' + q[1] : q[1];
        } else if (!pkg) {
          pkg = q[1];
        }
        token.lastIndex = qualifiedAfter.lastIndex;
        break;
      }
      case 'companion':
        if (lang === 'kotlin') companion = true;
        break;
      case '@JvmStatic':
        if (lang === 'kotlin') jvmStaticAt = paren;
        break;
      case 'external':
        if (lang === 'kotlin') externalAt = paren;
        break;
      case 'native': {
        // Java: a `native` modifier directly inside a class body.
        const t = top();
        if (lang !== 'java' || !t || t.kind !== 'class') break;
        const name = methodNameAfter(end);
        if (name) out.consumes.add(`jni:${t.name}#${name}`);
        break;
      }
      case 'val':
      case 'var':
      case 'def':
        if (pending && paren === pending.paren) pending = null;
        if (lang === 'kotlin' && paren === 0) {
          if (scopes.length === 0) topLevelMembers = true;
          clearModifiers();
        }
        break;
      case 'fun': {
        if (lang !== 'kotlin') break;
        funInterface.lastIndex = end;
        if (funInterface.test(code)) break; // `fun interface Foo`: the `interface` token handles it
        if (pending && paren === pending.paren) pending = null;
        const t = top();
        if (!t) topLevelMembers = true;
        if (externalAt >= 0 && (!t || t.kind === 'class')) {
          const name = methodNameAfter(end);
          // A companion's function is a static of the outer class only with @JvmStatic.
          const cls = !t ? fileFacade() : t.companionOf !== undefined && jvmStaticAt >= 0 ? t.companionOf : t.name;
          if (name && cls) out.consumes.add(`jni:${cls}#${name}`);
        }
        clearModifiers();
        break;
      }
      default: {
        // class, interface, enum, record, object, trait
        const isCompanion = companion && tok === 'object';
        companion = false;
        if (!classKeywords.has(tok)) break;
        const before = code.charCodeAt(m.index - 1);
        if (before === 46 || before === 58) break; // Foo.class, Foo::class
        nameAfter.lastIndex = end;
        const nm = nameAfter.exec(code);
        let name = nm ? nm[1] : '';
        if (tok === 'enum' && name === 'class') break;
        if (tok === 'record') {
          // `record` is only a keyword in a record header: `record Point(int x, int y)`.
          if (!nm) break;
          recordHeader.lastIndex = nameAfter.lastIndex;
          if (!recordHeader.test(code)) break;
        }
        if (!name) {
          if (!isCompanion) break; // an anonymous object expression
          name = 'Companion';
        }
        const t = top();
        if (t && t.kind === 'other') break; // a local class
        const parent = t && t.kind === 'class' ? t.name : '';
        const binary = parent ? parent + '$' + name : pkg ? pkg + '.' + name : name;
        out.provides.add('jvm:' + binary);
        if (lang === 'scala' && tok === 'object') out.provides.add('jvm:' + binary + '$');
        pending = { name: binary, paren, companionOf: isCompanion ? parent : undefined };
        if (nm) token.lastIndex = nameAfter.lastIndex;
        clearModifiers();
        break;
      }
    }
  }

  // Top-level Kotlin functions and properties live in the file's facade class (FooKt).
  if (lang === 'kotlin' && topLevelMembers) {
    const f = fileFacade();
    if (f) out.provides.add('jvm:' + f);
  }
}
