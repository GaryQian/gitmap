// Turning what the user picked or dropped into a RepoSource (PLAN.md §6.1).
//   Chromium:        showDirectoryPicker() / getAsFileSystemHandle()  → locator { kind: 'fsa' }
//   Firefox, Safari: <input webkitdirectory> / webkitGetAsEntry()     → locator { kind: 'files' }
//   A dropped *.starmap.json.gz                                        → { kind: 'snapshot' }
import { importModelFile, isModelFileName } from '../../content';
import type { RepoSource } from '../../contracts/pipeline';
import type { RepoLocator } from '../../contracts/git';
import { classifyDecodeError, classifyPickError } from '../status/classify';
import { say, type StatusCase } from '../status/messages';

export const SNAPSHOT_SUFFIX = '.starmap.json.gz';

/** A failure to get a source, as one of the cases of status/messages.ts; its message is that case's sentence. */
export class AcquireError extends Error {
  constructor(readonly status: StatusCase) {
    super(say(status).text);
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

/** A saved map by its name: `.starmap.json.gz`, or the same file a browser has already inflated. */
export function isSnapshotName(name: string): boolean {
  return isModelFileName(name);
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

/** True when a folder handle lists nothing at all. Throws what the browser throws when it cannot be listed. */
async function isEmptyDirectory(root: FileSystemDirectoryHandle): Promise<boolean> {
  const dir = root as FileSystemDirectoryHandle & { keys?(): AsyncIterableIterator<string> };
  if (typeof dir.keys !== 'function') return false;
  return (await dir.keys().next()).done === true;
}

/** A folder handle as a source. An empty folder is refused here, before anything is started for it. */
async function sourceFromDirectoryHandle(root: FileSystemDirectoryHandle): Promise<RepoSource> {
  let empty: boolean;
  try {
    empty = await isEmptyDirectory(root);
  } catch (err) {
    throw new AcquireError(classifyPickError(err) ?? 'folder-unreadable');
  }
  if (empty) throw new AcquireError('folder-empty');
  return { kind: 'directory', locator: { kind: 'fsa', root } };
}

/** The Chromium folder dialog. Resolves null when the user cancels it. */
export async function pickDirectory(): Promise<RepoSource | null> {
  const pick = (window as PickerWindow).showDirectoryPicker;
  if (!pick) throw new AcquireError('browser-no-folders');
  let root: FileSystemDirectoryHandle;
  try {
    root = await pick.call(window, { id: 'starmap', mode: 'read' });
  } catch (err) {
    const status = classifyPickError(err);
    if (status === null) return null; // the dialog was closed: nothing happened, so nothing is said
    throw new AcquireError(status);
  }
  return sourceFromDirectoryHandle(root);
}

export function sourceFromFileList(files: ArrayLike<File>): RepoSource {
  const locator = locatorFromFileList(files);
  if (locator.files.length === 0) throw new AcquireError('folder-empty');
  return { kind: 'directory', locator };
}

/** A dropped saved map. It opens as an import: no folder, so no file contents until one is chosen. */
export async function sourceFromSnapshotFile(file: File): Promise<RepoSource> {
  try {
    return { kind: 'snapshot', model: await importModelFile(file) };
  } catch (err) {
    throw new AcquireError(classifyDecodeError(err));
  }
}

/**
 * The folder input, for browsers without the folder dialog, made on demand so it also works away
 * from the landing page. Must be called from a click. Resolves null when nothing was chosen.
 */
function pickWithInput(): Promise<FilesLocator | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.setAttribute('webkitdirectory', '');
    input.className = 'gm-file-input';
    const done = (locator: FilesLocator | null) => { input.remove(); resolve(locator); };
    input.addEventListener('change', () => {
      const files = Array.from(input.files ?? []);
      done(files.length > 0 ? locatorFromFileList(files) : null);
    });
    input.addEventListener('cancel', () => done(null));
    document.body.append(input);
    input.click();
  });
}

/**
 * Ask for a folder to go with a map that is already open ("Choose the folder"). Call it from a
 * click. Resolves null when the viewer cancels; rejects with an AcquireError otherwise.
 */
export async function chooseDirectory(): Promise<RepoLocator | null> {
  if (canPickDirectory()) {
    const source = await pickDirectory();
    return source?.kind === 'directory' ? source.locator : null;
  }
  if (canUseFolderInput()) {
    const locator = await pickWithInput();
    if (locator && locator.files.length === 0) throw new AcquireError('folder-empty');
    return locator;
  }
  throw new AcquireError('browser-no-folders');
}

/** Up to `count` paths spread evenly through a list. */
export function samplePaths(paths: readonly string[], count: number): string[] {
  if (paths.length <= count) return [...paths];
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(paths[Math.floor((i * paths.length) / count)]!);
  return out;
}

const SAMPLE_PATHS = 8;

/**
 * Whether a folder holds any of a map's files: a cheap check that the folder chosen for an open map
 * is the one it was made from. A few paths are looked up; one hit is enough, since files come and go.
 * True for locators that cannot be looked into from here.
 */
export async function folderHasAnyOf(locator: RepoLocator, paths: readonly string[]): Promise<boolean> {
  if (paths.length === 0) return true;
  const sample = samplePaths(paths, SAMPLE_PATHS);
  if (locator.kind === 'files') {
    const have = new Set(locator.files.map((f) => f.path));
    return sample.some((p) => have.has(p));
  }
  if (locator.kind !== 'fsa') return true;
  for (const path of sample) {
    const parts = path.split('/');
    const name = parts.pop()!;
    try {
      let dir = locator.root;
      for (const part of parts) dir = await dir.getDirectoryHandle(part);
      await dir.getFileHandle(name);
      return true;
    } catch {
      // not there: try the next one
    }
  }
  return false;
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
  if (handle?.kind === 'directory') return sourceFromDirectoryHandle(handle as FileSystemDirectoryHandle);

  const { entry } = dropped;
  if (!handle && entry?.isDirectory) {
    let locator: FilesLocator;
    try { locator = await locatorFromEntry(entry as FileSystemDirectoryEntry, onCount); } catch { throw new AcquireError('folder-read-stopped'); }
    if (locator.files.length === 0) throw new AcquireError('folder-empty');
    return { kind: 'directory', locator };
  }

  // not a folder: the only file accepted is a saved map
  const name = handle?.name ?? entry?.name ?? dropped.file?.name ?? '';
  if (!isSnapshotName(name)) throw new AcquireError('not-a-folder');
  let file: File | null;
  try {
    file = handle ? await (handle as FileSystemFileHandle).getFile()
      : entry ? await entryFile(entry as FileSystemFileEntry)
      : dropped.file;
  } catch {
    file = dropped.file;
  }
  if (!file) throw new AcquireError('saved-map-unreadable');
  return sourceFromSnapshotFile(file);
}
