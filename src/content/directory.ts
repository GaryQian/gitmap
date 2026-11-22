// DirectorySource (PLAN.md §12.1): file contents from the user's own folder. It reads the working-tree
// file, not the committed blob, because that is the version the user would go and edit.
import type { ContentSource, RepoLocator, WorkingTree } from '../contracts/git';
import type { NodeRef } from '../model/types';
import { FsaWorkingTree } from '../git';
import { requestPermission } from '../persist';
import { pathOfRef } from './refs';

const cleanPath = (p: string): string => p.replace(/\\/g, '/').replace(/^(?:\.?\/)+/, '');

/** A dropped or picked file list: path → File, built on the first read. */
function fileListTree(files: { path: string; file: File }[]): Pick<WorkingTree, 'read'> {
  let byPath: Map<string, File> | null = null;
  return {
    async read(path) {
      byPath ??= new Map(files.map((f) => [cleanPath(f.path), f.file]));
      const file = byPath.get(path);
      if (!file) return null;
      try { return new Uint8Array(await file.arrayBuffer()); } catch { return null; }
    },
  };
}

/**
 * Write a file that already exists under `root`. Asks for write access first (the browser prompts
 * once per visit, and only inside a click or key press); never creates folders or files.
 */
async function writeFsa(root: FileSystemDirectoryHandle, path: string, bytes: Uint8Array): Promise<void> {
  if ((await requestPermission(root, 'readwrite')) !== 'granted') {
    throw new Error('Saving needs permission to change files in this folder.');
  }
  const parts = cleanPath(path).split('/');
  const name = parts.pop()!;
  let dir = root;
  try {
    for (const part of parts) dir = await dir.getDirectoryHandle(part);
    const handle = await dir.getFileHandle(name);
    const out = await handle.createWritable();
    try {
      await out.write(bytes as Uint8Array<ArrayBuffer>);
      await out.close();
    } catch (err) {
      await out.abort().catch(() => {});
      throw err;
    }
  } catch (err) {
    const why = err instanceof Error && err.message ? ` (${err.message})` : '';
    throw new Error(`Could not save "${path}"${why}.`);
  }
}

/**
 * A ContentSource over the folder a locator points at. 'fsa' walks directory handles, resolving each
 * folder once however many of its files are opened; 'files' looks the path up in the file list.
 * Null for the other kinds ('node', 'memory'), which have no browser folder behind them.
 */
export function directorySource(locator: RepoLocator): ContentSource | null {
  let tree: Pick<WorkingTree, 'read'>;
  if (locator.kind === 'fsa') tree = new FsaWorkingTree(locator.root);
  else if (locator.kind === 'files') tree = fileListTree(locator.files);
  else return null;
  return {
    async read(ref) {
      const path = pathOfRef(ref);
      const bytes = await tree.read(path);
      if (!bytes) {
        throw new Error(`Could not read "${path}" from the folder. It may have been moved or deleted, or the folder may need to be chosen again.`);
      }
      return bytes;
    },
    // a picked file list is a copy of the folder: there is nothing to write back to
    ...(locator.kind === 'fsa' && {
      write: (ref: NodeRef, bytes: Uint8Array) => writeFsa(locator.root, pathOfRef(ref), bytes),
    }),
  };
}
