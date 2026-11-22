// Tree-sitter runtime and grammar loading for the slow pass (PLAN.md §6.3). The same code runs in a
// browser pool worker, in the page, and in Node (tests, `npm run parse`):
//   browser: the .wasm files are fetched same-origin from <base>/grammars/ (public/grammars, filled
//            by scripts/copy-grammars.mjs before `dev` and `build`);
//   Node:    they are read from public/grammars/, else from the packages in node_modules.
// Either way the loader ends up with bytes and hands those to web-tree-sitter, so nothing after the
// read differs by environment. A grammar that cannot be loaded is remembered as missing.
import type { Language, Parser, Query } from 'web-tree-sitter';

type TreeSitter = typeof import('web-tree-sitter');

/** Reads one wasm file by name ('web-tree-sitter.wasm', 'tree-sitter-python.wasm'). Rejects when it is absent. */
export type LoadWasm = (file: string) => Promise<Uint8Array>;

const RUNTIME_WASM = 'web-tree-sitter.wasm';
/** Where the browser build serves the files, under the app's base URL. */
const GRAMMAR_URL_DIR = 'grammars/';
/** Where Node finds them, relative to the project root, in order of preference. */
const NODE_DIRS = ['public/grammars', 'node_modules/@repomix/tree-sitter-wasms/out', 'node_modules/web-tree-sitter'];

function isWasm(bytes: Uint8Array): boolean {
  return bytes.length > 8 && bytes[0] === 0x00 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d;
}

function inBrowser(): boolean {
  const g = globalThis as { process?: { versions?: { node?: string } }; location?: { href?: string } };
  return typeof g.location?.href === 'string' && typeof fetch === 'function' && !g.process?.versions?.node;
}

async function fetchWasm(file: string): Promise<Uint8Array> {
  const origin = new URL(self.location.href).origin;
  const base = new URL(import.meta.env?.BASE_URL ?? '/', origin + '/');
  const url = new URL(GRAMMAR_URL_DIR + file, base);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url.pathname}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function readWasmFromDisk(file: string): Promise<Uint8Array> {
  // Built at run time so the browser bundle never resolves a node: module (README rule 5).
  const node = (name: string) => import(/* @vite-ignore */ `node:${name}`);
  const [fs, path, url] = await Promise.all([node('fs/promises'), node('path'), node('url')]);
  const roots: string[] = [];
  if (import.meta.url.startsWith('file:')) roots.push(path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../../..'));
  const cwd = (globalThis as { process?: { cwd?(): string } }).process?.cwd?.();
  if (cwd && !roots.includes(cwd)) roots.push(cwd);
  for (const root of roots) {
    for (const dir of NODE_DIRS) {
      try { return new Uint8Array(await fs.readFile(path.join(root, dir, file))); } catch { /* try the next place */ }
    }
  }
  throw new Error(`${file} was not found under ${roots.join(' or ')}`);
}

/** The default LoadWasm: `fetch` in a browser, the file system in Node. Rejects on anything that is not a wasm module. */
export const loadWasmFile: LoadWasm = async (file) => {
  const bytes = await (inBrowser() ? fetchWasm(file) : readWasmFromDisk(file));
  // A dev server answers an unknown path with its index page and status 200.
  if (!isWasm(bytes)) throw new Error(`${file} is not a WebAssembly module`);
  return bytes;
};

// The runtime is one per JS realm inside web-tree-sitter itself, so its start-up is module state.
let runtime: Promise<TreeSitter | null> | null = null;

function startRuntime(loadWasm: LoadWasm): Promise<TreeSitter | null> {
  return (runtime ??= (async () => {
    try {
      const [ts, wasm] = await Promise.all([import('web-tree-sitter'), loadWasm(RUNTIME_WASM)]);
      // Exactly the module's bytes: Node may hand back a view into a larger pooled buffer.
      const exact = wasm.byteOffset === 0 && wasm.byteLength === wasm.buffer.byteLength ? wasm : wasm.slice();
      await ts.Parser.init({ wasmBinary: exact.buffer as ArrayBuffer });
      return ts;
    } catch (e) {
      console.warn(`[slow pass] the tree-sitter runtime did not load; files fall back to extractSymbols: ${String((e as Error)?.message ?? e)}`);
      return null;
    }
  })());
}

/** One grammar, ready to use: a parser set to its language, and the queries compiled against it. */
export interface GrammarBundle {
  readonly name: string;
  readonly language: Language;
  readonly parser: Parser;
  /** Captures ERROR and MISSING nodes, for SyntaxFacts.errorRate. */
  readonly errors: Query | null;
  /** The compiled query for a plug-in's source, or null when the source does not compile (warned once). */
  query(owner: string, source: string): Query | null;
}

const CACHE_KEY = 'ingest.syntax.grammars';

function compile(ts: TreeSitter, language: Language, source: string): Query {
  return new ts.Query(language, source);
}

async function openGrammar(name: string, loadWasm: LoadWasm): Promise<GrammarBundle | null> {
  if (!/^[\w.+-]+$/.test(name)) return null;
  const ts = await startRuntime(loadWasm);
  if (!ts) return null;
  try {
    const language = await ts.Language.load(await loadWasm(`tree-sitter-${name}.wasm`));
    const parser = new ts.Parser();
    parser.setLanguage(language);
    let errors: Query | null = null;
    for (const source of ['(ERROR) @error (MISSING) @missing', '(ERROR) @error']) {
      try { errors = compile(ts, language, source); break; } catch { /* an older grammar ABI without MISSING queries */ }
    }
    const queries = new Map<string, Query | null>();
    return {
      name, language, parser, errors,
      query(owner, source) {
        const key = `${owner}\n${source}`;
        let q = queries.get(key);
        if (q === undefined) {
          try { q = compile(ts, language, source); } catch (e) {
            q = null;
            console.warn(`[slow pass] the ${owner} query for grammar ${name} does not compile: ${String((e as Error)?.message ?? e)}`);
          }
          queries.set(key, q);
        }
        return q;
      },
    };
  } catch (e) {
    console.warn(`[slow pass] grammar ${name} did not load: ${String((e as Error)?.message ?? e)}`);
    return null;
  }
}

/**
 * The grammar bundle for a name, loaded once per worker and kept in `cache` (TaskContext.cache).
 * Resolves with null, now and on every later call, when the grammar or the runtime cannot be loaded.
 */
export function loadGrammar(cache: Map<string, unknown>, name: string, loadWasm: LoadWasm = loadWasmFile): Promise<GrammarBundle | null> {
  let grammars = cache.get(CACHE_KEY) as Map<string, Promise<GrammarBundle | null>> | undefined;
  if (!grammars) cache.set(CACHE_KEY, (grammars = new Map()));
  let bundle = grammars.get(name);
  if (!bundle) grammars.set(name, (bundle = openGrammar(name, loadWasm)));
  return bundle;
}
