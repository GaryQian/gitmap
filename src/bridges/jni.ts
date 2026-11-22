// JNI native-method name mangling, exactly as the JNI specification defines it ("Resolving Native
// Method Names"), and its inverse.
//
//   Java_ + mangled fully-qualified class name + _ + mangled method name [+ __ + mangled argument signature]
//
// with these escapes:  . or /  →  _        _  →  _1        ;  →  _2        [  →  _3
//                      any other character that is not an ASCII letter or digit  →  _0xxxx
//                      (four lower-case hex digits of its UTF-16 code unit; $ is _00024)

function isAlnum(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

function escape(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (isAlnum(c)) out += s[i];
    else if (c === 46 || c === 47) out += '_';
    else if (c === 95) out += '_1';
    else if (c === 59) out += '_2';
    else if (c === 91) out += '_3';
    else out += '_0' + c.toString(16).padStart(4, '0');
  }
  return out;
}

/**
 * The C symbol of a native method.
 * @param className fully-qualified binary name, with `.` or `/` separators and `$` before a nested
 *   class: `com.foo.Bar`, `com/foo/Outer$Inner`.
 * @param methodName the Java method name.
 * @param argSignature for an overloaded native method, the argument part of its JVM descriptor
 *   (`ILjava/lang/String;[J`); a whole descriptor (`(I)V`) is accepted and its arguments used.
 *   Pass `''` for an overload that takes no arguments. Omit for the short name.
 */
export function mangleJni(className: string, methodName: string, argSignature?: string): string {
  let symbol = 'Java_' + escape(className) + '_' + escape(methodName);
  if (argSignature !== undefined) {
    let args = argSignature;
    if (args.charCodeAt(0) === 40) {
      const close = args.indexOf(')');
      args = args.slice(1, close < 0 ? args.length : close);
    }
    symbol += '__' + escape(args);
  }
  return symbol;
}

export interface JniName {
  /** Dotted binary name: `com.foo.Bar`, `com.foo.Outer$Inner`. */
  className: string;
  method: string;
  /** Argument part of the JVM descriptor when the symbol carries one (`''` for no arguments). */
  signature?: string;
}

function isHex(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70);
}

/** Whether `_0xxxx` starts at index `i` (the underscore). */
function isUnicodeEscape(s: string, i: number): boolean {
  return s.charCodeAt(i + 1) === 48 && isHex(s.charCodeAt(i + 2)) && isHex(s.charCodeAt(i + 3))
    && isHex(s.charCodeAt(i + 4)) && isHex(s.charCodeAt(i + 5));
}

function unescapeSignature(s: string): string | null {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 95) {
      if (!isAlnum(c)) return null;
      out += s[i];
      continue;
    }
    const d = s.charCodeAt(i + 1);
    if (d === 49) { out += '_'; i++; }
    else if (d === 50) { out += ';'; i++; }
    else if (d === 51) { out += '['; i++; }
    else if (isUnicodeEscape(s, i)) { out += String.fromCharCode(parseInt(s.slice(i + 2, i + 6), 16)); i += 5; }
    else out += '/';
  }
  return out;
}

/**
 * Inverse of `mangleJni`: the class, method and (when present) argument signature a `Java_…` symbol
 * names. Null when the symbol is not a well-formed JNI name. Because Java names never start with a
 * digit, the escapes are unambiguous and `mangleJni(d.className, d.method, d.signature) === symbol`.
 */
export function demangleJni(symbol: string): JniName | null {
  if (!symbol.startsWith('Java_')) return null;
  const s = symbol;
  const parts: string[] = [];
  let cur = '';
  let signature: string | undefined;
  let i = 5;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c !== 95) {
      if (!isAlnum(c)) return null;
      cur += s[i++];
      continue;
    }
    const d = s.charCodeAt(i + 1);
    if (d === 49) { cur += '_'; i += 2; continue; }
    if (isUnicodeEscape(s, i)) { cur += String.fromCharCode(parseInt(s.slice(i + 2, i + 6), 16)); i += 6; continue; }
    if (d === 95) {
      // "__" is either a separator followed by an escaped character (a name that starts with '_'
      // or '$'), or the start of the argument signature. A signature cannot start with a digit.
      const e = s.charCodeAt(i + 2);
      if (e !== 49 && !isUnicodeEscape(s, i + 1)) {
        const sig = unescapeSignature(s.slice(i + 2));
        if (sig === null) return null;
        signature = sig;
        break;
      }
    } else if (!isAlnum(d) || (d >= 48 && d <= 57)) {
      return null; // trailing '_', or '_2' / '_3' / a digit where a name must start
    }
    if (cur === '') return null;
    parts.push(cur);
    cur = '';
    i++;
  }
  if (cur === '' || parts.length === 0) return null;
  const out: JniName = { className: parts.join('.'), method: cur };
  if (signature !== undefined) out.signature = signature;
  return out;
}
