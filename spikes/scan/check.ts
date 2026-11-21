import { readFileSync } from 'node:fs';
import { parseGitIndex } from './gitindex.ts';
import { scan, langOf } from './scanner.ts';
const [, , dir] = process.argv;
const got = parseGitIndex(readFileSync(dir + '/.git/index')).map(e => e.path).join('\n');
const exp = readFileSync(dir + '/expected.txt', 'utf8').trim();
console.log('v4 index matches git ls-files:', got === exp);
const R = 'C:/Users/Gary/git/';
for (const p of ['react/packages/react-dom/src/client/ReactDOMRoot.js', 'tensorflow/tensorflow/python/keras/__init__.py', 'flutter/packages/flutter/lib/src/widgets/framework.dart', 'tensorflow/tensorflow/core/framework/tensor.cc']) {
  try { const r = scan(readFileSync(R + p, 'utf8'), langOf(p)!); console.log(p, r.loc, 'lines →', r.imports.slice(0, 8).join(' | '), r.imports.length > 8 ? `(+${r.imports.length - 8})` : ''); } catch (e) { console.log(p, 'missing'); }
}
