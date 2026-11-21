// worker_threads scaling check: N workers pull file indices from a shared atomic counter,
// each reads + decodes + parses + queries + deletes. Reports wall time per N.
// usage: npx tsx treesitter/scale.ts --repo <path> --langs a,b --workers 1,2,4,8,14 [--repeat 1]
import { Worker } from 'node:worker_threads';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { listFiles } from './lib.ts';

const argv = process.argv.slice(2);
const arg = (k: string, d?: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const repo = arg('--repo')!;
const langs = arg('--langs')!.split(',');
const counts = arg('--workers', '1,2,4,8,14')!.split(',').map(Number);
const tag = arg('--tag', path.basename(repo));
const files = listFiles(repo, new Set(langs)); // git order = directory order, as the plan prescribes
const workerFile = path.join(import.meta.dirname, 'worker.ts');

async function run(n: number) {
  const counter = new Int32Array(new SharedArrayBuffer(4));
  const t0 = performance.now();
  let peakRss = 0;
  const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 50);
  const workers = Array.from({ length: n }, () => new Worker(workerFile, { execArgv: ['--import', 'tsx'], workerData: { repo, langs, files, counter } }));
  let readyAt = 0, ready = 0;
  const startGate = new Int32Array(new SharedArrayBuffer(4));
  const results = await Promise.all(workers.map(w => new Promise<any>((res, rej) => {
    w.on('message', (m) => {
      if (m.type === 'ready') { if (++ready === n) { readyAt = performance.now(); for (const x of workers) x.postMessage('go'); } }
      else if (m.type === 'done') { res(m); w.terminate(); }
    });
    w.on('error', rej);
  })));
  const t1 = performance.now();
  clearInterval(sampler);
  const sum = (k: string) => results.reduce((a, r) => a + r[k], 0);
  return {
    workers: n, files: sum('files'), MB: +(sum('bytes') / 1048576).toFixed(1),
    startupMs: Math.round(readyAt - t0), workMs: Math.round(t1 - readyAt), totalMs: Math.round(t1 - t0),
    cpuParseMs: Math.round(sum('parseMs')), cpuQueryMs: Math.round(sum('queryMs')), cpuReadMs: Math.round(sum('readMs')),
    slowestWorkerBusyMs: Math.round(Math.max(...results.map(r => r.parseMs + r.queryMs + r.readMs))),
    peakRssMB: Math.round(peakRss / 1048576),
  };
}

const rows: any[] = [];
for (const n of counts) {
  const r = await run(n);
  rows.push(r);
  console.log(JSON.stringify(r));
}
const base = rows.find(r => r.workers === 1);
if (base) for (const r of rows) r.speedup = +(base.workMs / r.workMs).toFixed(2);
console.table(rows);
writeFileSync(path.join(import.meta.dirname, `out-scale-${tag}.json`), JSON.stringify(rows, null, 1));
