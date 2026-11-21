// Fresh-process cold load timing for one grammar. Prints JSON.
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const [name, dir, runtime] = process.argv.slice(2);
const file = path.join(dir, `tree-sitter-${name}.wasm`);
const t0 = performance.now();
let Lang: any, P: any;
if (runtime === 'legacy') { P = createRequire(import.meta.url)('web-tree-sitter-legacy'); await P.init(); Lang = P.Language; }
else { const m = await import('web-tree-sitter'); await m.Parser.init(); P = m.Parser; Lang = m.Language; }
const t1 = performance.now();
const bytes = readFileSync(file);
const t2 = performance.now();
const lang = await Lang.load(new Uint8Array(bytes));
const t3 = performance.now();
const p = new P(); p.setLanguage(lang); const tree = p.parse('x'); tree.delete();
const t4 = performance.now();
const lang2 = await Lang.load(new Uint8Array(bytes));
const t5 = performance.now();
console.log(JSON.stringify({ name, runtimeInitMs: t1 - t0, readMs: t2 - t1, loadMs: t3 - t2, firstParseMs: t4 - t3, secondLoadMs: t5 - t4 }));
