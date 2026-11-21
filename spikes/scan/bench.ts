import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { cpus } from 'node:os';
import { parseGitIndex } from './gitindex.ts';
import { langOf, scan } from './scanner.ts';

const repo = process.argv[2];
const nWorkers = Number(process.argv[3] ?? Math.max(1, cpus().length - 2));
const maxBytes = 1 << 20;

let t = performance.now();
const idx = readFileSync(repo + '/.git/index');
const entries = parseGitIndex(idx);
const tIndex = performance.now() - t;
const code = entries.filter(e => langOf(e.path) && e.size <= maxBytes && (e.mode & 0o170000) === 0o100000);
const totalBytes = code.reduce((s, e) => s + e.size, 0);
console.log(`${repo}: index ${(idx.length / 1e6).toFixed(1)} MB, ${entries.length} entries parsed in ${tIndex.toFixed(1)} ms; ${code.length} code files, ${(totalBytes / 1e6).toFixed(1)} MB`);

// Round-robin by directory-sorted order, chunked so each worker gets contiguous directories.
const sorted = code.map(e => e.path).sort();
async function run(n: number) {
  const chunks: string[][] = Array.from({ length: n }, () => []);
  const per = Math.ceil(sorted.length / n);
  sorted.forEach((p, i) => chunks[Math.floor(i / per)].push(p));
  const t0 = performance.now();
  const results = await Promise.all(chunks.map(paths => new Promise<any>((res, rej) => {
    const w = new Worker(new URL('./worker.ts', import.meta.url), { workerData: { root: repo, paths }, execArgv: ['--import', 'tsx'] });
    w.once('message', res); w.once('error', rej);
  })));
  const wall = performance.now() - t0;
  const sum = (k: string) => results.reduce((s, r) => s + r[k], 0);
  const slow = results.flatMap(r => r.slow).sort((a, b) => b[0] - a[0]).slice(0, 3);
  return { n, wall, readMs: sum('readMs'), scanMs: sum('scanMs'), bytes: sum('bytes'), imports: sum('imports'), loc: sum('loc'), slow };
}
for (const n of [1, nWorkers]) {
  const r = await run(n);
  console.log(`  workers=${r.n}: wall ${(r.wall / 1000).toFixed(2)} s | read ${(r.readMs / 1000).toFixed(2)} s, scan ${(r.scanMs / 1000).toFixed(2)} s (summed) | scan ${(r.bytes / 1e6 / (r.scanMs / 1000)).toFixed(1)} MB/s per core | ${r.imports} imports, ${r.loc} lines | slowest: ${r.slow.map(([ms, p]: any) => `${p} ${ms.toFixed(0)}ms`).join(', ')}`);
}
