// Shared helpers for the tree-sitter slow-pass spike.
import { Parser, Language, Query, type Node } from 'web-tree-sitter';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { QUERIES } from './queries.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
export const MODERN_DIR = path.join(here, '../node_modules/@repomix/tree-sitter-wasms/out');
export const LEGACY_DIR = path.join(here, '../node_modules/tree-sitter-wasms/out');

// extension -> grammar name (file name stem in the wasm packages)
export const EXT_LANG: Record<string, string> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python',
  cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', h: 'cpp', cu: 'cpp',
  c: 'c',
  dart: 'dart',
  java: 'java',
  rs: 'rust',
  go: 'go',
  cs: 'c_sharp',
  swift: 'swift',
};

let inited = false;
export async function init() {
  if (!inited) { await Parser.init(); inited = true; }
}

export interface LangBundle { lang: Language; parser: Parser; query: Query | null }
const cache = new Map<string, LangBundle>();
export async function getLang(name: string): Promise<LangBundle> {
  let b = cache.get(name);
  if (b) return b;
  await init();
  const lang = await Language.load(path.join(MODERN_DIR, `tree-sitter-${name}.wasm`));
  const parser = new Parser();
  parser.setLanguage(lang);
  const src = QUERIES[name];
  const query = src ? new Query(lang, src) : null;
  b = { lang, parser, query };
  cache.set(name, b);
  return b;
}

export function listFiles(repo: string, langs: Set<string>): { rel: string; lang: string }[] {
  const out = execFileSync('git', ['-C', repo, 'ls-files', '-z'], { maxBuffer: 1 << 28 }).toString('utf8');
  const res: { rel: string; lang: string }[] = [];
  for (const rel of out.split('\0')) {
    if (!rel) continue;
    const dot = rel.lastIndexOf('.');
    if (dot < 0) continue;
    const lang = EXT_LANG[rel.slice(dot + 1).toLowerCase()];
    if (lang && langs.has(lang)) res.push({ rel, lang });
  }
  return res;
}

export let sink = 0;
export interface Extracted { defs: number; refs: number; names: number }

// Runs the tags query and materialises what the real pipeline would keep:
// (kind, name text, start row) per @name capture.
export function extract(query: Query, root: Node): Extracted {
  const caps = query.captures(root);
  let defs = 0, refs = 0;
  const out: { n: string; r: number }[] = [];
  for (const c of caps) {
    if (c.name === 'name') { out.push({ n: c.node.text, r: c.node.startPosition.row }); continue; }
    if (c.name.startsWith('definition')) defs++;
    else if (c.name.startsWith('reference')) refs++;
  }
  sink += out.length;
  return { defs, refs, names: out.length };
}

export interface FileResult {
  rel: string; lang: string; bytes: number;
  parseMs: number; queryMs: number; cancelled: boolean; hasError: boolean;
  defs: number; refs: number;
}

// Parse one file's text with a safety cap; returns timings. Deletes the tree unless keep=true.
export function processFile(b: LangBundle, rel: string, lang: string, text: string, bytes: number,
  capMs: number, runQuery: boolean, keep: any[] | null): FileResult {
  const t0 = performance.now();
  const deadline = t0 + capMs;
  const tree = b.parser.parse(text, null, capMs > 0 ? { progressCallback: () => performance.now() > deadline } : undefined);
  const t1 = performance.now();
  if (!tree) {
    b.parser.reset();
    return { rel, lang, bytes, parseMs: t1 - t0, queryMs: 0, cancelled: true, hasError: true, defs: 0, refs: 0 };
  }
  let ex: Extracted = { defs: 0, refs: 0, names: 0 };
  const hasError = tree.rootNode.hasError;
  if (runQuery && b.query) ex = extract(b.query, tree.rootNode);
  const t2 = performance.now();
  if (keep) keep.push(tree); else tree.delete();
  return { rel, lang, bytes, parseMs: t1 - t0, queryMs: t2 - t1, cancelled: false, hasError, defs: ex.defs, refs: ex.refs };
}
