import { parentPort, workerData } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { scan, langOf } from './scanner.ts';

const { root, paths } = workerData as { root: string; paths: string[] };
const td = new TextDecoder();
let readMs = 0, scanMs = 0, bytes = 0, imports = 0, loc = 0;
const slow: [number, string][] = [];
for (const p of paths) {
  const t0 = performance.now();
  const buf = readFileSync(root + '/' + p);
  const t1 = performance.now();
  const r = scan(td.decode(buf), langOf(p)!);
  const t2 = performance.now();
  readMs += t1 - t0; scanMs += t2 - t1; bytes += buf.length; imports += r.imports.length; loc += r.loc;
  if (t2 - t1 > 20) slow.push([t2 - t1, p]);
}
parentPort!.postMessage({ readMs, scanMs, bytes, imports, loc, files: paths.length, slow });
