// Turning what the user picked or dropped into a RepoSource (PLAN.md §6.1).
//   Chromium:        showDirectoryPicker() / getAsFileSystemHandle()  → locator { kind: 'fsa' }
//   Firefox, Safari: <input webkitdirectory> / webkitGetAsEntry()     → locator { kind: 'files' }
//   A dropped *.gitmap.json.gz                                        → { kind: 'snapshot' }
import type { RepoSource } from '../../contracts/pipeline';
import type { RepoLocator } from '../../contracts/git';
import { decodeModel } from '../../model';

export const SNAPSHOT_SUFFIX = '.gitmap.json.gz';

export const MESSAGES = {
  unsupported: 'This browser cannot open folders. Try a desktop version of Chrome, Edge, Firefox or Safari.',
  unreadable: 'That folder could not be read.',
  empty: 'That folder has no files in it.',
  notAFolder: `Drop a folder, or a ${SNAPSHOT_SUFFIX} file.`,
  badSnapshot: 'That file could not be read as a saved map.',
} as const;

/** An error whose message is written for the line under "Choose a folder". */
export class AcquireError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AcquireError';
  }
}

type FilesLocator = Extract<RepoLocator, { kind: 'files' }>;
type PickerWindow = Window & { showDirectoryPicker?: (opts?: { id?: string; mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle> };
type HandleItem = DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> };

export function canPickDirectory(): boolean {
  return typeof window !== 'undefined' && typeof (window as PickerWindow).showDirectoryPicker === 'function';
}
export function canUseFolderInput(): boolean {
  return typeof HTMLInputElement !== 'undefined' && 'webkitdirectory' in HTMLInputElement.prototype;
}

export function isSnapshotName(name: string): boolean {
  return name.toLowerCase().endsWith(SNAPSHOT_SUFFIX);
}

/** "top/src/a.ts" → { top: "top", path: "src/a.ts" }. Backslashes and leading slashes are normalised. */
export function splitTopFolder(relativePath: string): { top: string; path: string } {
  const clean = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const i = clean.indexOf('/');
  return i < 0 ? { top: '', path: clean } : { top: clean.slice(0, i), path: clean.slice(i + 1) };
}

/**
 * Files from `<input type="file" webkitdirectory>`: each has webkitRelativePath "folder/sub/file".
 * The top folder becomes the repo name and is removed from every path.
 */
export function locatorFromFileList(files: ArrayLike<File>): FilesLocator {
  const out: FilesLocator['files'] = [];
  let name = '';
  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    const { top, path } = splitTopFolder(file.webkitRelativePath || file.name);
    if (!path) continue;
    if (!name) name = top;
    out.push({ path, file });
  }
  return { kind: 'files', name: name || 'folder', files: out };
}

/** The Chromium folder dialog. Resolves null when the user cancels it. */
export async function pickDirectory(): Promise<RepoSource | null> {
  const pick = (window as PickerWindow).showDirectoryPicker;
  if (!pick) throw new AcquireError(MESSAGES.unsupported);
  try {
    const root = await pick.call(window, { id: 'gitmap', mode: 'read' });
    return { kind: 'directory', locator: { kind: 'fsa', root } };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return null;
    throw new AcquireError(MESSAGES.unreadable);
  }
}

export function sourceFromFileList(files: ArrayLike<File>): RepoSource {
  const locator = locatorFromFileList(files);
  if (locator.files.length === 0) throw new AcquireError(MESSAGES.empty);
  return { kind: 'directory', locator };
}

export async function sourceFromSnapshotFile(file: File): Promise<RepoSource> {
  try {
    const model = await decodeModel(new Uint8Array(await file.arrayBuffer()));
    return { kind: 'snapshot', model };
  } catch {
    throw new AcquireError(MESSAGES.badSnapshot);
  }
}

// ---- drag and drop ----

/** What was taken from a drop event before it ended, best route first. */
export interface Dropped {
  /** Chromium: a handle that can be kept and read lazily. Resolves null when the browser has none to give. */
  handle: Promise<FileSystemHandle | null> | null;
  entry: FileSystemEntry | null;
  file: File | null;
}

/**
 * Take the first dropped item. Must run inside the drop handler: the item list is emptied as soon
 * as the handler returns, so every route is requested here and the best one is resolved later.
 */
export function captureDrop(data: DataTransfer | null): Dropped | null {
  const item = Array.from(data?.items ?? []).find((it) => it.kind === 'file') as HandleItem | undefined;
  if (!item) return null;
  return {
    handle: typeof item.getAsFileSystemHandle === 'function' ? item.getAsFileSystemHandle().catch(() => null) : null,
    entry: typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null,
    file: item.getAsFile(),
  };
}

function readAll(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = [];
    // readEntries hands back a batch at a time and an empty batch at the end
    const next = () => reader.readEntries((batch) => {
      if (batch.length === 0) resolve(all);
      else { all.push(...batch); next(); }
    }, reject);
    next();
  });
}

function entryFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

/** Every file under a dropped directory entry, with paths relative to it. */
export async function locatorFromEntry(root: FileSystemDirectoryEntry, onCount?: (n: number) => void): Promise<FilesLocator> {
  const files: FilesLocator['files'] = [];
  const dirs: FileSystemDirectoryEntry[] = [root];
  const prefix = root.fullPath.replace(/\/+$/, '') + '/';
  while (dirs.length > 0) {
    const entries = await readAll(dirs.pop()!.createReader());
    const fileEntries: FileSystemFileEntry[] = [];
    for (const e of entries) {
      if (e.isDirectory) dirs.push(e as FileSystemDirectoryEntry);
      else if (e.isFile) fileEntries.push(e as FileSystemFileEntry);
    }
    const got = await Promise.all(fileEntries.map((e) => entryFile(e).catch(() => null)));
    got.forEach((file, i) => {
      const full = fileEntries[i]!.fullPath;
      if (file && full.startsWith(prefix)) files.push({ path: full.slice(prefix.length), file });
    });
    onCount?.(files.length);
  }
  return { kind: 'files', name: root.name, files };
}

/** Resolve a captured drop. `onCount` reports files found so far while a folder is being walked. */
export async function sourceFromDrop(dropped: Dropped, onCount?: (n: number) => void): Promise<RepoSource> {
  const handle = await dropped.handle;
  if (handle?.kind === 'directory') return { kind: 'directory', locator: { kind: 'fsa', root: handle as FileSystemDirectoryHandle } };

  const { entry } = dropped;
  if (!handle && entry?.isDirectory) {
    let locator: FilesLocator;
    try { locator = await locatorFromEntry(entry as FileSystemDirectoryEntry, onCount); } catch { throw new AcquireError(MESSAGES.unreadable); }
    if (locator.files.length === 0) throw new AcquireError(MESSAGES.empty);
    return { kind: 'directory', locator };
  }

  // not a folder: the only file accepted is a saved map
  const name = handle?.name ?? entry?.name ?? dropped.file?.name ?? '';
  if (!isSnapshotName(name)) throw new AcquireError(MESSAGES.notAFolder);
  let file: File | null;
  try {
    file = handle ? await (handle as FileSystemFileHandle).getFile()
      : entry ? await entryFile(entry as FileSystemFileEntry)
      : dropped.file;
  } catch {
    file = dropped.file;
  }
  if (!file) throw new AcquireError(MESSAGES.badSnapshot);
  return sourceFromSnapshotFile(file);
}
