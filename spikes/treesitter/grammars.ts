// Grammar sizes (raw/gzip/brotli) and cold load times (median of N fresh processes).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { MODERN_DIR, LEGACY_DIR } from './lib.ts';
const TARGETS: [string, string][] = [['TypeScript','typescript'],['TSX','tsx'],['JavaScript','javascript'],['Python','python'],['C','c'],['C++','cpp'],['Obj-C','objc'],['Java','java'],['Kotlin','kotlin'],['C#','c_sharp'],['Go','go'],['Rust','rust'],['Dart','dart'],['Swift','swift']];
const N = Number(process.argv[2] ?? 5);
const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const rows: any[] = [];
for (const [label, name] of TARGETS) {
  const modern = path.join(MODERN_DIR, `tree-sitter-${name}.wasm`);
  const legacy = path.join(LEGACY_DIR, `tree-sitter-${name}.wasm`);
  const useModern = existsSync(modern);
  const file = useModern ? modern : legacy;
  if (!existsSync(file)) { rows.push({ label, name, missing: true }); continue; }
  const buf = readFileSync(file);
  const legacySize = existsSync(legacy) ? readFileSync(legacy).length : null;
  const gz = gzipSync(buf, { level: 9 }).length;
  const br = brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
  const runs: any[] = [];
  for (let i = 0; i < N; i++) {
    const out = execFileSync(process.execPath, ['--import', 'tsx', 'loadone.ts', name, useModern ? MODERN_DIR : LEGACY_DIR, useModern ? 'modern' : 'legacy'], { cwd: import.meta.dirname }).toString();
    runs.push(JSON.parse(out.trim().split('\n').pop()!));
  }
  const r = { label, name, source: useModern ? '@repomix/tree-sitter-wasms@0.1.17' : 'tree-sitter-wasms@0.1.13 (legacy runtime)', raw: buf.length, gzip: gz, brotli: br, legacyRaw: legacySize,
    runtimeInitMs: med(runs.map(r => r.runtimeInitMs)), loadMs: med(runs.map(r => r.loadMs)), firstParseMs: med(runs.map(r => r.firstParseMs)), secondLoadMs: med(runs.map(r => r.secondLoadMs)) };
  rows.push(r); console.log(JSON.stringify(r));
}
writeFileSync(path.join(import.meta.dirname, 'out-grammars.json'), JSON.stringify(rows, null, 1));
