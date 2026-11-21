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
  let readMs = 0, scanMs = 0, bytes = 0, imports = 0;
  for (const p of paths) {
    const t0 = performance.now();
    const cut = p.lastIndexOf('/');
    const dir = await dirOf(cut < 0 ? '' : p.slice(0, cut));
    const buf = await (await (await dir.getFileHandle(p.slice(cut + 1))).getFile()).arrayBuffer();
    const t1 = performance.now();
    imports += scan(td.decode(buf), langOf(p)!).imports.length;
    scanMs += performance.now() - t1; readMs += t1 - t0; bytes += buf.byteLength;
  }
  postMessage({ readMs, scanMs, bytes, imports });
};
