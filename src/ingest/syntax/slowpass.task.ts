// Pool task 'ingest.slowPass' (PLAN.md §6.3): one batch of manifest entries → one SyntaxFacts each.
// Bytes are read exactly as the fast pass reads them (the git object store for 'pack' entries, the
// working tree otherwise, and on a pack miss). Each file is parsed with its plug-in's tree-sitter
// grammar and the plug-in's query is run over the tree; a plug-in without a loadable grammar falls
// back to its extractSymbols. One parser, language and compiled query per grammar are kept per
// worker in ctx.cache. A bad file never fails the batch: it comes back with `skipped` set.
//
// Protocol with runSlowPass, as in the fast pass: a returned fact carries the entry's `oid` only when
// its bytes came from git. Working-tree reads come back with `oid: ''`; runSlowPass restores the oid
// and keeps those facts out of the cache.
import type { Config } from '../../config';
import { defineTask, type TaskDef } from '../../contracts/compute';
import type { GitFs, GitRepo, RepoAccess } from '../../contracts/git';
import type { ManifestEntry } from '../../contracts/ingest';
import type { LanguagePlugin, SyntaxFacts } from '../../contracts/lang';
import { openGitRepo } from '../../git';
import { pluginById } from '../../lang';
import { now } from '../../shared';
import { looksBinary } from '../facts';
import type { OpenGit } from '../manifest';
import { errorShare, extractSymbols } from './extract';
import { loadGrammar, loadWasmFile, type GrammarBundle, type LoadWasm } from './loader';

export const SLOW_PASS_TASK = 'ingest.slowPass';
export interface SlowPassInput { entries: ManifestEntry[] }

/** The fast pass keeps its GitRepo under this key; the slow pass shares it, so a worker opens the repo once. */
const GIT_CACHE_KEY = 'ingest.gitRepo';
/** Working-tree reads kept in flight per worker (PLAN.md §6.3.1, item 5). */
const TREE_READS_IN_FLIGHT = 8;
/** Caps of SymbolDef.signature and SymbolDef.doc until config.parser has values of its own. */
const SIGNATURE_CHARS = 200;
const DOC_CHARS = 300;

export interface SlowPassTaskOptions {
  /** Inject a GitRepo in tests. */
  openGit?: OpenGit;
  /** Inject the wasm reader in tests (a grammar that fails to load). */
  loadWasm?: LoadWasm;
  /** Inject plug-ins in tests. */
  lookup?: (id: string) => LanguagePlugin | undefined;
}

function limitsFor(config: Config): { signatureChars: number; docChars: number } {
  const p = config.parser as { signatureChars?: number; docChars?: number };
  return { signatureChars: p.signatureChars ?? SIGNATURE_CHARS, docChars: p.docChars ?? DOC_CHARS };
}

function gitFor(repo: RepoAccess, cache: Map<string, unknown>, openGit: OpenGit): GitRepo | null {
  if (!repo.git) return null;
  const held = cache.get(GIT_CACHE_KEY) as { fs: GitFs; git: GitRepo | null } | undefined;
  if (held && held.fs === repo.git) return held.git;
  let git: GitRepo | null = null;
  try { git = openGit(repo.git); } catch { /* every entry falls back to the working tree */ }
  cache.set(GIT_CACHE_KEY, { fs: repo.git, git });
  return git;
}

function readBlob(git: GitRepo, oid: string): Uint8Array | null {
  try {
    const obj = git.readObject(oid);
    return obj && obj.type === 'blob' ? obj.data : null;
  } catch { return null; }
}

const decoder = new TextDecoder('utf-8');

function round4(x: number): number { return Math.round(x * 10000) / 10000; }

/**
 * Facts for one file from its bytes. `grammars` holds the bundles already loaded for this batch
 * (null for a grammar that is missing). Never throws.
 */
export function syntaxFactsFromBytes(
  entry: ManifestEntry,
  bytes: Uint8Array,
  config: Config,
  grammars: ReadonlyMap<string, GrammarBundle | null>,
  lookup: (id: string) => LanguagePlugin | undefined = pluginById,
): SyntaxFacts {
  const facts: SyntaxFacts = { path: entry.path, oid: entry.oid, defs: [], refs: [] };
  const skip = (why: NonNullable<SyntaxFacts['skipped']>): SyntaxFacts => ({ path: entry.path, oid: entry.oid, defs: [], refs: [], skipped: why });
  const plugin = entry.lang ? lookup(entry.lang) : undefined;
  if (!plugin || (!plugin.syntax && !plugin.extractSymbols)) return skip('no-grammar');
  if (bytes.length > config.parser.maxFileBytes) return skip('too-large');
  if (looksBinary(bytes)) return skip('error');
  const deadline = now() + config.reveal.perFileTimeoutMs;
  const late = () => now() > deadline;
  try {
    const text = decoder.decode(bytes);
    let bundle: GrammarBundle | null = null;
    let query = null;
    if (plugin.syntax) {
      // With the text in hand the plug-in can tell what the path alone cannot (an Objective-C `.h`).
      const name = plugin.syntax.grammar(entry.path, text);
      if (name === null) return skip('no-grammar'); // the plug-in opts this file out
      // '' is the plug-in asking for its extractSymbols on this file: not a grammar that is missing.
      if (name !== '') {
        const source = plugin.syntax.queries[name];
        bundle = grammars.get(name) ?? null;
        if (bundle && typeof source === 'string') {
          query = bundle.query(plugin.id, source);
          if (!query) return skip('error'); // a query that does not compile is a plug-in bug, not a missing grammar
        } else bundle = null;
      }
    }
    if (!bundle || !query) {
      if (!plugin.extractSymbols) return skip('no-grammar');
      const found = plugin.extractSymbols(text, entry.path);
      if (late()) return skip('timeout'); // it cannot be interrupted, only disowned
      facts.defs = found.defs ?? [];
      facts.refs = found.refs ?? [];
      return facts;
    }

    const tree = bundle.parser.parse(text, null, { progressCallback: late });
    if (!tree) {
      bundle.parser.reset(); // or the next parse would resume this one
      return skip('timeout');
    }
    try {
      const root = tree.rootNode;
      const rule = plugin.syntax?.exported;
      const found = extractSymbols(root, query, text, {
        ...limitsFor(config),
        exported: rule ? (name, kind) => rule(name, kind) : undefined,
        query: { progressCallback: late },
      });
      if (late()) return skip('timeout');
      facts.defs = found.defs;
      facts.refs = found.refs;
      facts.errorRate = round4(errorShare(root, bundle.errors, text.length));
      return facts;
    } finally {
      tree.delete(); // trees live in the WASM heap; the garbage collector never frees them (IMPLEMENTATION.md §4)
    }
  } catch {
    return skip('error');
  }
}

export function createSlowPassTask(options: SlowPassTaskOptions = {}): TaskDef<SlowPassInput, SyntaxFacts[]> {
  const openGit = options.openGit ?? openGitRepo;
  const loadWasm = options.loadWasm ?? loadWasmFile;
  const lookup = options.lookup ?? pluginById;
  return defineTask<SlowPassInput, SyntaxFacts[]>({
    type: SLOW_PASS_TASK,
    async run(input, ctx) {
      const repo = await ctx.repo();
      if (!repo) throw new Error(`${SLOW_PASS_TASK}: no repo is set on the pool`);
      const { entries } = input;

      // Load the grammars and compile the queries this batch needs before the loop: the loop is then
      // synchronous per file, and a query's compile time (a second for a large grammar) is not
      // charged to the first file's time cap.
      const grammars = new Map<string, GrammarBundle | null>();
      const wanted = new Map<string, Map<string, string>>(); // grammar → plug-in id → query source
      for (const e of entries) {
        const plugin = e.lang ? lookup(e.lang) : undefined;
        if (!plugin?.syntax || e.read === 'none') continue;
        let name: string | null = null;
        try { name = plugin.syntax.grammar(e.path); } catch { /* reported per file below */ }
        // '' asks for extractSymbols: there is no grammar to load, and none to record as failed
        if (name === null || name === '') continue;
        let owners = wanted.get(name);
        if (!owners) wanted.set(name, (owners = new Map()));
        const source = plugin.syntax.queries[name];
        if (typeof source === 'string') owners.set(plugin.id, source);
      }
      await Promise.all([...wanted].map(async ([name, owners]) => {
        const bundle = await loadGrammar(ctx.cache, name, loadWasm);
        grammars.set(name, bundle);
        if (bundle) for (const [owner, source] of owners) bundle.query(owner, source);
      }));

      const out = new Array<SyntaxFacts>(entries.length);
      const fromTree: number[] = [];
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        if (e.read === 'none') { out[i] = { path: e.path, oid: e.oid, defs: [], refs: [], skipped: 'too-large' }; continue; }
        const git = e.read === 'pack' ? gitFor(repo, ctx.cache, openGit) : null;
        const bytes = git ? readBlob(git, e.oid) : null;
        if (bytes) out[i] = syntaxFactsFromBytes(e, bytes, ctx.config, grammars, lookup);
        else fromTree.push(i);
      }
      for (let k = 0; k < fromTree.length; k += TREE_READS_IN_FLIGHT) {
        const slice = fromTree.slice(k, k + TREE_READS_IN_FLIGHT);
        const reads = await Promise.all(slice.map((i) => repo.tree.read(entries[i].path).catch(() => null)));
        slice.forEach((i, j) => {
          const e = entries[i];
          const bytes = reads[j];
          const facts: SyntaxFacts = bytes ? syntaxFactsFromBytes(e, bytes, ctx.config, grammars, lookup) : { path: e.path, oid: '', defs: [], refs: [], skipped: 'error' };
          facts.oid = ''; // not verified against the index (see the protocol note above)
          out[i] = facts;
        });
      }
      return out;
    },
  });
}

export default createSlowPassTask();
