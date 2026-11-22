import { scan, langOf } from '../scan/scanner.ts';
const td = new TextDecoder();
onmessage = async (e: MessageEvent) => {
  const { root, paths } = e.data as { root: FileSystemDirectoryHandle; paths: string[] };
  const dirs = new Map<string, FileSystemDirectoryHandle>([['', root]]);
  async function dirOf(path: string): Promise<FileSystemDirectoryHandle> {
    let d = dirs.get(path); if (d) return d;
    const cut = path.lastIndexOf('/');
    const parent = await dirOf(cut < 0 ? '' : path.slice(0, cut));
    d = await parent.getDirectoryHandle(path.slice(cut + 1)); dirs.set(path, d); return d;
  }
  let readMs = 0, scanMs = 0, bytes = 0, imports = 0, errors = 0;
  const errorSamples: string[] = [];
  for (const p of paths) {
    try {
      const t0 = performance.now();
      const cut = p.lastIndexOf('/');
      const dir = await dirOf(cut < 0 ? '' : p.slice(0, cut));
      const buf = await (await (await dir.getFileHandle(p.slice(cut + 1))).getFile()).arrayBuffer();
      const t1 = performance.now();
      imports += scan(td.decode(buf), langOf(p)!).imports.length;
      scanMs += performance.now() - t1; readMs += t1 - t0; bytes += buf.byteLength;
    } catch (err: any) {
      errors++;
      if (errorSamples.length < 5) errorSamples.push(`${p}: ${err?.name ?? ''} ${err?.message ?? err}`);
    }
  }
  postMessage({ readMs, scanMs, bytes, imports, errors, errorSamples });
};
