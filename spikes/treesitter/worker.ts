import { parentPort, workerData } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getLang, processFile } from './lib.ts';

const { repo, langs, files, counter } = workerData as { repo: string; langs: string[]; files: { rel: string; lang: string }[]; counter: Int32Array };
for (const l of langs) await getLang(l);
parentPort!.postMessage({ type: 'ready' });
parentPort!.once('message', async () => {
  const dec = new TextDecoder();
  let n = 0, bytes = 0, parseMs = 0, queryMs = 0, readMs = 0, over2s = 0;
  for (;;) {
    const i = Atomics.add(counter, 0, 1);
    if (i >= files.length) break;
    const { rel, lang } = files[i];
    const r0 = performance.now();
    const buf = readFileSync(path.join(repo, rel));
    const text = dec.decode(buf);
    readMs += performance.now() - r0;
    const r = processFile(await getLang(lang), rel, lang, text, buf.length, 10000, true, null);
    n++; bytes += buf.length; parseMs += r.parseMs; queryMs += r.queryMs;
    if (r.parseMs + r.queryMs > 2000) over2s++;
  }
  parentPort!.postMessage({ type: 'done', files: n, bytes, parseMs, queryMs, readMs, over2s });
});
