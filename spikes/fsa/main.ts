import { parseGitIndex } from '../scan/gitindex.ts';
import { langOf } from '../scan/scanner.ts';
const out = document.getElementById('out')!;
const log = (s: string) => { out.textContent += '\n' + s; console.log(s); };
document.getElementById('go')!.onclick = async () => {
  out.textContent = '';
  const root: FileSystemDirectoryHandle = await (window as any).showDirectoryPicker();
  const n = Number((document.getElementById('n') as HTMLInputElement).value);
  let t = performance.now();
  const git = await root.getDirectoryHandle('.git');
  const buf = new Uint8Array(await (await (await git.getFileHandle('index')).getFile()).arrayBuffer());
  const entries = parseGitIndex(buf);
  const code = entries.filter(e => langOf(e.path) && e.size <= 1 << 20 && (e.mode & 0o170000) === 0o100000).map(e => e.path).sort();
  log(`${root.name}: ${entries.length} index entries in ${(performance.now() - t).toFixed(1)} ms, ${code.length} code files`);
  for (const workers of [1, n]) {
    const per = Math.ceil(code.length / workers);
    t = performance.now();
    const res = await Promise.all(Array.from({ length: workers }, (_, i) => new Promise<any>(r => {
      const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = e => { r(e.data); w.terminate(); };
      w.postMessage({ root, paths: code.slice(i * per, (i + 1) * per) });
    })));
    const wall = performance.now() - t;
    const s = (k: string) => res.reduce((a, r) => a + r[k], 0);
    log(`workers=${workers}: wall ${(wall / 1000).toFixed(2)} s | ${(s('bytes') / 1e6).toFixed(1)} MB | handle+read ${(s('readMs') / 1000).toFixed(2)} s, scan ${(s('scanMs') / 1000).toFixed(2)} s (summed) | ${s('imports')} imports`);
  }
  log('done');
};
