// Node-only test helper: run a tree-sitter query against source text, so a language plug-in can
// check its query compiles and captures what it should before the slow-pass runner (2B) exists.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Language, Parser, Query } from 'web-tree-sitter';
import { projectRoot } from './fixture';

let ready: Promise<void> | null = null;
const languages = new Map<string, Promise<Language>>();

/** Absolute path of a grammar wasm by name ('typescript', 'python', 'c_sharp', …), or null if no package ships it. */
export function grammarPath(name: string): string | null {
  const root = projectRoot();
  for (const p of [
    path.join(root, 'public/grammars', `tree-sitter-${name}.wasm`),
    path.join(root, 'node_modules/@repomix/tree-sitter-wasms/out', `tree-sitter-${name}.wasm`),
    path.join(root, 'node_modules/tree-sitter-wasms/out', `tree-sitter-${name}.wasm`),
  ]) if (existsSync(p)) return p;
  return null;
}

export async function loadGrammar(name: string): Promise<Language> {
  ready ??= Parser.init();
  await ready;
  let lang = languages.get(name);
  if (!lang) {
    const file = grammarPath(name);
    if (!file) throw new Error(`no grammar wasm for ${name}`);
    languages.set(name, (lang = Language.load(file)));
  }
  return lang;
}

export interface QueryCapture { capture: string; text: string; line: number }

/** Every capture of `querySource` over `text`, in document order. Frees the tree (IMPLEMENTATION.md §4). */
export async function runQuery(grammar: string, querySource: string, text: string): Promise<QueryCapture[]> {
  const lang = await loadGrammar(grammar);
  const parser = new Parser();
  parser.setLanguage(lang);
  const tree = parser.parse(text);
  if (!tree) throw new Error('parse failed');
  const query = new Query(lang, querySource);
  try {
    return query.captures(tree.rootNode).map((c) => ({ capture: c.name, text: c.node.text, line: c.node.startPosition.row + 1 }));
  } finally {
    query.delete();
    tree.delete();
    parser.delete();
  }
}
