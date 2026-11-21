// Copy the tree-sitter runtime and grammar .wasm files into public/grammars/, where the app fetches
// them lazily and same-origin (PLAN.md §6.3). Runs before `dev` and `build`; the output is gitignored.
// Kotlin, Objective-C and Scala have no build for the current runtime (M0-RESULTS.md) and are left out:
// those plug-ins fall back to LanguagePlugin.extractSymbols.
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'public/grammars');
mkdirSync(out, { recursive: true });

const copyIfNewer = (from, to) => {
  if (existsSync(to) && statSync(to).mtimeMs >= statSync(from).mtimeMs && statSync(to).size === statSync(from).size) return false;
  copyFileSync(from, to);
  return true;
};

let copied = 0;
const grammars = path.join(root, 'node_modules/@repomix/tree-sitter-wasms/out');
for (const name of readdirSync(grammars)) {
  if (name.endsWith('.wasm') && copyIfNewer(path.join(grammars, name), path.join(out, name))) copied++;
}
if (copyIfNewer(path.join(root, 'node_modules/web-tree-sitter/web-tree-sitter.wasm'), path.join(out, 'web-tree-sitter.wasm'))) copied++;
if (copied) console.log(`copied ${copied} wasm files to public/grammars`);
