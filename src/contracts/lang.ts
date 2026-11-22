// Languages are plug-ins (PLAN.md §6.3, §6.4). Each lives in src/lang/<id>/ and default-exports a
// LanguagePlugin (or an array of them) from its index.ts; src/lang/index.ts discovers them with
// import.meta.glob, so adding a language never touches a shared file.
import type { LangId } from '../model/types';

/** One import/include/use statement found by the fast pass. */
export interface ImportSpec {
  /** The specifier as written: './foo', 'os.path', 'vector', 'com.foo.Bar', 'package:x/y.dart'. */
  spec: string;
  /** Free-form per-language tag the resolver understands: 'import', 'include', 'include-system', 'use', 'require', 'mod', 'from', ... */
  kind: string;
  /** Imported names when the statement lists them (`import { a, b } from`, `from x import a, b`). '*' for everything. */
  names?: string[];
}

/** What a plug-in's fast-pass scanner returns for one file. */
export interface ScanResult {
  imports: ImportSpec[];
  /**
   * Declarations the resolver needs that are visible without a syntax tree, as string lists by key:
   * for example { package: ['com.foo'] }, { namespace: ['A.B'] }, { module: ['foo::bar'] }, { classes: ['Bar'] }.
   */
  decls?: Record<string, string[]>;
  /** Cross-language bridge keys in a shared namespace such as 'jni:com.foo.Bar#load' (PLAN.md §6.4.1). */
  bridge?: { provides?: string[]; consumes?: string[] };
}

/** Per-file result of the fast pass. Cached by blob oid; must be JSON-serialisable. */
export interface FileFacts extends ScanResult {
  path: string;
  oid: string;
  bytes: number;
  /** Plug-in id, or null for a file no plug-in claims (it still gets a sphere). */
  lang: LangId | null;
  /** Line count. 0 for binary and skipped files. */
  loc: number;
  /**
   * Leading text kept for manifests (tsconfig.json, go.mod, ...) and docs (README, ARCHITECTURE, ...):
   * manifests in full up to parser.maxFileBytes, docs up to parser.excerptBytes.
   */
  excerpt?: string;
  /** Set when the file was not scanned; it still gets a sphere sized from `bytes`. */
  skipped?: 'binary' | 'too-large' | 'timeout' | 'unreadable';
}

export type SymbolKind = 'function' | 'method' | 'class' | 'interface' | 'type' | 'enum' | 'struct' | 'trait' | 'module' | 'constant' | 'variable' | 'macro';
export interface SymbolDef {
  name: string;
  kind: SymbolKind;
  line: number;         // 1-based
  /** Enclosing class/namespace/module name when known. */
  container?: string;
  /** False when the language marks it private to the file (static, non-exported, underscore-private). Default true. */
  exported?: boolean;
  /** First line of the definition with the body removed, for the AI digest. */
  signature?: string;
  /** Leading doc comment, trimmed and capped (~300 chars). */
  doc?: string;
}
export type RefKind = 'call' | 'type' | 'inherit' | 'reference';
export interface SymbolRef {
  name: string;
  kind: RefKind;
  /** Number of occurrences in the file. */
  count: number;
  /** The `x` in `x.name` / `x::name` when it is a plain identifier (module alias, namespace, class). */
  qualifier?: string;
}

/** Per-file result of the slow pass. Cached by blob oid; must be JSON-serialisable. */
export interface SyntaxFacts {
  path: string;
  oid: string;
  defs: SymbolDef[];
  refs: SymbolRef[];
  /** Share of the syntax tree that is ERROR nodes, 0..1. */
  errorRate?: number;
  skipped?: 'no-grammar' | 'timeout' | 'too-large' | 'error';
}

/** Read-only index over every file's fast-pass facts, handed to resolvers. */
export interface RepoIndex {
  readonly files: readonly FileFacts[];
  /** Facts by exact path. */
  get(path: string): FileFacts | undefined;
  has(path: string): boolean;
  /** Paths whose basename (with extension) equals `name`. */
  byBasename(name: string): readonly string[];
  /** Paths directly inside a directory ('' is the root). */
  inDir(dir: string): readonly string[];
  /** Files of one language. */
  byLang(lang: LangId): readonly FileFacts[];
  /** Paths ending with '/' + suffix or equal to suffix (for include-style suffix matching). */
  bySuffix(suffix: string): readonly string[];
  /** Kept text of a manifest or doc file (FileFacts.excerpt), or undefined. */
  text(path: string): string | undefined;
}

export interface ResolvedImport {
  /** Target file path. */
  path: string;
  /** 0..1. Use 1 for exact resolutions, lower for fuzzy ones (namespace → several files, suffix guesses). */
  confidence: number;
}

/** Built once per analysis run, then asked about each import of each file of its language. */
export interface Resolver {
  /** Files an import refers to. Empty for external or unresolvable imports. */
  resolve(file: FileFacts, imp: ImportSpec): ResolvedImport[];
  /**
   * Scope keys of a file: files that share a key see each other's symbols without importing
   * (Java/Kotlin/Scala package, Go package directory, C# namespace, Swift module, Rust crate).
   */
  scopes?(file: FileFacts): string[];
  /**
   * Scope keys a file can read without being a member: one-way visibility. The file sees the
   * symbols of every file whose scopes() include one of these keys, but those files do not see it
   * (Swift: the modules a file imports; C#: its parent namespaces and the namespaces it uses).
   * The linker ranks such a match like an import without a listed name.
   */
  sees?(file: FileFacts): string[];
}

/**
 * Tree-sitter slow-pass description. Query captures follow the `tags.scm` convention:
 *   (function_declaration name: (identifier) @name) @definition.function
 *   (call_expression function: (identifier) @name) @reference.call
 * Definition captures: @definition.{function,method,class,interface,type,enum,struct,trait,module,constant,variable,macro}
 * Reference captures:  @reference.{call,type,inherit,reference}
 * The inner @name capture is the symbol's identifier. An optional @qualifier capture inside a
 * reference pattern names the object/namespace it is accessed through. An optional @container
 * capture inside a definition pattern names its enclosing class or namespace.
 */
export interface SyntaxSpec {
  /**
   * Grammar name for a file: the stem of a wasm file under public/grammars/ (tree-sitter-<name>.wasm),
   * for example 'typescript', 'tsx', 'python', 'cpp'.
   * - null skips the slow pass for that file.
   * - '' means "no grammar for this file: use `extractSymbols`" (a `.h` file of the C++ plug-in that
   *   turns out to be Objective-C, which the C++ grammar cannot read). Nothing is loaded for it.
   * `text` is the file's content where the caller has it: the slow pass passes it per file, while
   * planning (which grammars a batch needs, whether a file has a slow pass at all) sees the path
   * alone. With the path alone, answer for the usual file of that kind.
   */
  grammar(path: string, text?: string): string | null;
  /** Query source per grammar name. */
  queries: Record<string, string>;
  /**
   * Language rule for SymbolDef.exported when it follows from the name alone (Go: upper-case first
   * letter; Python: no leading underscore). When absent the runner decides from the syntax tree.
   */
  exported?(name: string, kind: SymbolKind): boolean;
}

export interface LanguagePlugin {
  /** Stable id, also the key into config.visual.languageColors: 'ts', 'python', 'cpp', ... */
  id: LangId;
  /** Display name: 'TypeScript'. */
  name: string;
  /** Lower-case extensions without the dot. */
  extensions: string[];
  /** Exact basenames this plug-in also claims (for example 'CMakeLists.txt'). */
  filenames?: string[];
  /** Fallback colour (#rrggbb) when config.visual.languageColors has no entry for `id`. */
  color: string;
  /** Basenames or '*.ext' patterns of manifest files whose full text the fast pass keeps for this plug-in's resolver. */
  manifests?: string[];
  /** Words whose presence makes the fast pass call `scan` with `bridge: true` (PLAN.md §6.4.1). */
  bridgeTriggers?: string[];
  /**
   * Fast pass: imports and declarations without a syntax tree. Must skip comments and strings,
   * be linear in the text length, and never throw. Line counting is done by the caller.
   */
  scan(text: string, path: string): ScanResult;
  /** Slow pass with tree-sitter. Omit for languages with no grammar or no slow pass (CSS, HTML). */
  syntax?: SyntaxSpec;
  /**
   * Slow-pass fallback without a grammar: definitions and references by regular expression.
   * Used when `syntax` is absent or its grammar fails to load.
   */
  extractSymbols?(text: string, path: string): { defs: SymbolDef[]; refs: SymbolRef[] };
  /** Build this language's import resolver over the whole repo. */
  createResolver?(index: RepoIndex): Resolver;
}
