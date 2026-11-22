// Slow pass for Vue, Svelte and Astro without a grammar (LanguagePlugin.extractSymbols): definitions
// and references by conservative regular expressions over the script blocks, plus the component tags
// of the template. A component is itself a definition named after its file, so `<UserCard />` in
// one component links to UserCard.vue: that is how components reference each other.
import type { RefKind, SymbolDef, SymbolKind, SymbolRef } from '../../contracts/lang';
import { basename, dirname } from '../../shared';
import { splitComponent, type ComponentKind } from './blocks';

/** Comments and string literals. Template literals go whole, including code inside `${…}`. */
const NOISE = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\[\s\S]|[^`\\])*`/g;
/** Same-length copy with comments and strings blanked; line breaks stay. */
const blank = (code: string): string => code.replace(NOISE, (m) => m.replace(/[^\n]/g, ' '));

const ID = '[A-Za-z_$][\\w$]*';
/** A declaration at the start of a top-level line. Groups: export, function, class, interface|enum, its name, type, const|let|var, its name. */
const DEF = new RegExp(
  `^(export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:(?:async\\s+)?function\\s*\\*?\\s*(${ID})|(?:abstract\\s+)?class\\s+(${ID})|(interface|enum)\\s+(${ID})|type\\s+(${ID})\\s*[=<]|(const|let|var)\\s+(${ID})\\s*(?:[=:;]|$))`,
);
/** The right-hand side of `const name = …` when it is a function. */
const FUNCTION_VALUE = new RegExp(`=\\s*(?:async\\s*)?(?:function\\b|\\([^)]*\\)\\s*(?::[^=]+)?=>|${ID}\\s*=>)`);
const CALL = new RegExp(`(${ID})\\s*\\(`, 'g');
const QUALIFIER = new RegExp(`(^|[^\\w$.)\\]])(${ID})\\s*\\??\\.\\s*$`);

const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'await', 'import', 'require', 'super', 'constructor',
  'with', 'do', 'else', 'new', 'delete', 'void', 'yield', 'in', 'of', 'case', 'throw', 'async', 'get', 'set', 'static', 'instanceof',
]);
/** Objects whose methods are never repo symbols. */
const BUILTIN_OBJECTS = new Set(['this', 'console', 'Math', 'JSON', 'Object', 'Array', 'Promise', 'Number', 'String', 'Date', 'window', 'document']);

const MAX_SIGNATURE = 160;

/** `user-card.vue` → UserCard; `Button/index.vue` → Button. */
function componentName(path: string): string {
  let base = basename(path).replace(/\.[^.]*$/, '');
  if (base.toLowerCase() === 'index') base = basename(dirname(path)) || base;
  const name = base.split(/[^A-Za-z0-9$]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join('');
  return name || 'Component';
}

function scriptDefs(script: string, firstLine: number, defs: SymbolDef[]): void {
  const code = blank(script).split('\n');
  const source = script.split('\n');
  // Top level = the smallest indentation in the block (script contents are often indented one step).
  let indent = Infinity;
  for (const line of code) {
    const lead = line.search(/\S/);
    if (lead >= 0 && lead < indent) indent = lead;
  }
  for (let i = 0; i < code.length; i++) {
    const line = code[i];
    if (line.search(/\S/) !== indent) continue;
    const m = DEF.exec(line.slice(indent));
    if (!m) continue;
    let kind: SymbolKind;
    let name: string;
    if (m[2]) { kind = 'function'; name = m[2]; }
    else if (m[3]) { kind = 'class'; name = m[3]; }
    else if (m[5]) { kind = m[4] === 'enum' ? 'enum' : 'interface'; name = m[5]; }
    else if (m[6]) { kind = 'type'; name = m[6]; }
    else { name = m[8]; kind = FUNCTION_VALUE.test(line) ? 'function' : m[7] === 'const' ? 'constant' : 'variable'; }
    const def: SymbolDef = { name, kind, line: firstLine + i, exported: !!m[1] };
    if (kind !== 'constant' && kind !== 'variable') {
      def.signature = source[i].trim().replace(/\s*[{(=]?\s*$/, '').slice(0, MAX_SIGNATURE);
    }
    defs.push(def);
  }
}

/** Template text that is code: Vue `{{ … }}` and bound attribute values; Svelte and Astro `{ … }`. */
function templateCode(template: string, kind: ComponentKind): string {
  let out = '';
  if (kind === 'vue') {
    const rx = /\{\{([\s\S]*?)\}\}|\s(?:[:@#]|v-)[^\s"'<>=]*="([^"]*)"/g;
    for (let m: RegExpExecArray | null; (m = rx.exec(template)); ) out += (m[1] ?? m[2]) + '\n';
    return out;
  }
  let depth = 0, start = 0;
  for (let i = 0; i < template.length; i++) {
    const c = template.charCodeAt(i);
    if (c === 123) { if (depth++ === 0) start = i + 1; }
    else if (c === 125 && depth > 0 && --depth === 0) out += template.slice(start, i) + '\n';
  }
  return out;
}

export function extractComponentSymbols(text: string, path: string, kind: ComponentKind): { defs: SymbolDef[]; refs: SymbolRef[] } {
  const parts = splitComponent(text, kind, true);
  const defs: SymbolDef[] = [{ name: componentName(path), kind: 'class', line: 1, exported: true }];
  const refs = new Map<string, SymbolRef>();
  const ref = (name: string, refKind: RefKind, qualifier?: string): void => {
    const key = `${refKind} ${qualifier ?? ''} ${name}`;
    const r = refs.get(key);
    if (r) r.count++;
    else refs.set(key, qualifier ? { name, kind: refKind, count: 1, qualifier } : { name, kind: refKind, count: 1 });
  };
  const calls = (code: string): void => {
    CALL.lastIndex = 0;
    for (let m: RegExpExecArray | null; (m = CALL.exec(code)); ) {
      const name = m[1];
      if (KEYWORDS.has(name)) continue;
      const before = code.slice(Math.max(0, m.index - 80), m.index);
      if (/[\w$]$/.test(before) || /\bfunction\s*\*?\s*$/.test(before)) continue; // mid-identifier, or a declaration
      if (/\.\s*$/.test(before)) { // a method call: kept only as `name.method(`
        const q = QUALIFIER.exec(before);
        if (q && !BUILTIN_OBJECTS.has(q[2])) ref(name, 'call', q[2]);
      } else ref(name, 'call');
    }
  };

  let offset = 0, line = 1;
  for (const s of parts.scripts) {
    for (; offset < s.offset; offset++) if (text.charCodeAt(offset) === 10) line++;
    scriptDefs(s.text, line, defs);
    calls(blank(s.text));
  }
  calls(blank(templateCode(parts.template, kind)));

  // Component tags: <UserCard>, <Layout.Header> (its first name), and for Vue also <user-card>.
  for (const m of parts.template.matchAll(/<([A-Z][A-Za-z0-9_$]*)(?=[\s/>.])/g)) ref(m[1], 'reference');
  if (kind === 'vue') {
    for (const m of parts.template.matchAll(/<([a-z][a-z0-9]*(?:-[a-z0-9]+)+)(?=[\s/>])/g)) {
      ref(m[1].replace(/(?:^|-)([a-z0-9])/g, (_, ch: string) => ch.toUpperCase()), 'reference');
    }
  }
  return { defs, refs: [...refs.values()] };
}
