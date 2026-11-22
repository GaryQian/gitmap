// What this browser can do, asked once (PLAN.md §6.1). Three things are hard requirements: without
// workers, WebGL 2 or the gzip streams there is no map at all, and the landing page says which is
// missing instead of offering a button that cannot work. Two are conveniences: without the folder
// dialog the folder input and drag-and-drop still open a folder, but it cannot be remembered.
// SharedArrayBuffer is neither: without cross-origin isolation the app copies positions instead of
// sharing them, and says nothing.
import { listOf, type StatusCase, type StatusParams } from './messages';

export interface BrowserSupport {
  /** `showDirectoryPicker`: the folder can be remembered between visits. */
  picker: boolean;
  /** `<input webkitdirectory>`. */
  folderInput: boolean;
  workers: boolean;
  webgl2: boolean;
  /** `CompressionStream` and `DecompressionStream` (saved maps, demos, git objects). */
  compression: boolean;
}

/** What the app looks at. Passed in by tests; the real one is the page's own globals. */
export interface SupportEnv {
  showDirectoryPicker?: unknown;
  folderInput?: boolean;
  Worker?: unknown;
  CompressionStream?: unknown;
  DecompressionStream?: unknown;
  /** Try to make a WebGL 2 context. */
  webgl2?: () => boolean;
}

/** One throwaway context on a canvas that is never attached; it is released at once. */
function canCreateWebgl2(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

function pageEnv(): SupportEnv {
  const w = globalThis as unknown as SupportEnv;
  return {
    showDirectoryPicker: w.showDirectoryPicker,
    folderInput: typeof HTMLInputElement !== 'undefined' && 'webkitdirectory' in HTMLInputElement.prototype,
    Worker: w.Worker,
    CompressionStream: w.CompressionStream,
    DecompressionStream: w.DecompressionStream,
    webgl2: typeof document === 'undefined' ? () => false : canCreateWebgl2,
  };
}

export function probeSupport(env: SupportEnv = pageEnv()): BrowserSupport {
  return {
    picker: typeof env.showDirectoryPicker === 'function',
    folderInput: env.folderInput === true,
    workers: typeof env.Worker === 'function',
    webgl2: env.webgl2?.() === true,
    compression: typeof env.CompressionStream === 'function' && typeof env.DecompressionStream === 'function',
  };
}

let cached: BrowserSupport | null = null;

/** This page's support, probed on first use (the WebGL probe makes a context, so it is done once). */
export function browserSupport(): BrowserSupport {
  cached ??= probeSupport();
  return cached;
}

/** The hard requirements this browser lacks, in the words the landing line uses. */
export function missingRequirements(support: BrowserSupport): string[] {
  const missing: string[] = [];
  if (!support.workers) missing.push('web workers');
  if (!support.webgl2) missing.push('WebGL 2');
  if (!support.compression) missing.push('gzip streams');
  return missing;
}

export interface SupportVerdict {
  /** False when nothing can work: no button, no repo pills. */
  usable: boolean;
  /** False when only drag-and-drop is left for a folder. */
  canChoose: boolean;
  /** The line the landing page shows without being asked, if any. */
  line: { id: StatusCase; params?: StatusParams } | null;
}

/** What the landing page offers and says for a given browser. */
export function supportVerdict(support: BrowserSupport): SupportVerdict {
  const missing = missingRequirements(support);
  if (missing.length > 0) {
    const onlyWebgl = missing.length === 1 && missing[0] === 'WebGL 2';
    return {
      usable: false,
      canChoose: false,
      line: onlyWebgl ? { id: 'webgl-unavailable' } : { id: 'browser-missing', params: { what: listOf(missing) } },
    };
  }
  if (support.picker) return { usable: true, canChoose: true, line: null };
  // Drag-and-drop needs nothing from this list, so a folder can still be dropped either way.
  return { usable: true, canChoose: support.folderInput, line: { id: support.folderInput ? 'folder-not-remembered' : 'browser-no-folders' } };
}
