// Runs the spike's git history walker in a browser worker against a disk-backed folder.
// Setup (async): collect File objects for .git/HEAD, refs, packed-refs and objects/**.
// Walk (sync): GitFs.readAt = FileReaderSync on File.slice.
import { History } from '../core/history.ts';
import type { GitFs } from '../core/fs.ts';

class BrowserGitFs implements GitFs {
  private fr = new FileReaderSync();
  constructor(private files: Map<string, File>, private dirs: Map<string, string[]>) {}
  readAt(p: string, offset: number, length: number): Uint8Array {
    const f = this.files.get(p);
    if (!f) throw new Error('missing ' + p);
    return new Uint8Array(this.fr.readAsArrayBuffer(f.slice(offset, offset + length)));
  }
  size(p: string): number { return this.files.get(p)?.size ?? -1; }
  list(dir: string): string[] { return this.dirs.get(dir.replace(/\/$/, '')) ?? []; }
}

async function collect(dir: FileSystemDirectoryHandle, prefix: string, files: Map<string, File>, dirs: Map<string, string[]>) {
  const names: string[] = [];
  const jobs: Promise<void>[] = [];
  for await (const [name, h] of (dir as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
    names.push(name);
    const p = prefix ? prefix + '/' + name : name;
    if (h.kind === 'file') jobs.push((h as FileSystemFileHandle).getFile().then(f => { files.set(p, f); }));
    else jobs.push(collect(h as FileSystemDirectoryHandle, p, files, dirs));
  }
  dirs.set(prefix, names);
  await Promise.all(jobs);
}

onmessage = async (e: MessageEvent) => {
  try {
    const { root, maxCommits } = e.data as { root: FileSystemDirectoryHandle; maxCommits?: number };
    const t0 = performance.now();
    const git = await root.getDirectoryHandle('.git');
    const files = new Map<string, File>(), dirs = new Map<string, string[]>();
    const top: string[] = [];
    for await (const [name, h] of (git as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
      top.push(name);
      if (h.kind === 'file' && (name === 'HEAD' || name === 'packed-refs')) files.set(name, await (h as FileSystemFileHandle).getFile());
      if (h.kind === 'directory' && (name === 'refs' || name === 'objects')) await collect(h as FileSystemDirectoryHandle, name, files, dirs);
    }
    dirs.set('', top);
    postMessage({ type: 'setup', files: files.size, ms: performance.now() - t0 });
    const tWalk = performance.now();
    const h = new History(new BrowserGitFs(files, dirs), {
      maxCommits, timeLimitMs: undefined, cacheBytes: 32 << 20, pageSize: 256 << 10, maxPages: 512, coChangeMaxFiles: 50,
      onProgress: (commits: number, ms: number) => postMessage({ type: 'progress', commits, ms }),
    } as any);
    h.run();
    const runMs = performance.now() - tWalk;
    const s = h.odb.stats as any;
    postMessage({ type: 'done', summary: {
      setupMs: Math.round(tWalk - t0), runMs: Math.round(runMs), commits: h.commitsWalked,
      commitsPerSec: Math.round(h.commitsWalked / (runMs / 1000)), stoppedBy: h.stoppedBy, packs: h.odb.packs.length,
      paths: h.paths.length, headFiles: h.headFiles.size, headCoverage: +(h.headCovered / Math.max(1, h.headFiles.size)).toFixed(3),
      authors: h.authors.length, io: s.io, inflateMs: Math.round(s.inflateMs),
    } });
  } catch (err: any) { postMessage({ type: 'error', message: String(err?.stack ?? err) }); }
};
