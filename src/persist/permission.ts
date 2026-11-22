// Permission on a directory handle that came back out of IndexedDB (PLAN.md §6.1, §12). A stored
// handle keeps its identity but not its grant: on a return visit it usually reports 'prompt', and
// one click turns that into 'granted'.

export type FolderPermission = 'granted' | 'prompt' | 'denied';

/** queryPermission / requestPermission are Chromium-only and not in the TypeScript DOM library. */
type PermissionedHandle = FileSystemHandle & {
  queryPermission?(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
};

/**
 * Whether the folder can be read right now, without asking. Safe to call at any time, from the
 * page or a worker. A handle with no permission methods (an engine without the File System Access
 * permission model) reports 'granted'; a handle that throws reports 'denied'.
 */
export async function queryPermission(handle: FileSystemHandle, mode: 'read' | 'readwrite' = 'read'): Promise<FolderPermission> {
  const h = handle as PermissionedHandle;
  if (typeof h.queryPermission !== 'function') return 'granted';
  try {
    return await h.queryPermission({ mode });
  } catch {
    return 'denied';
  }
}

/**
 * Ask the user for read (or, with `mode`, write) access to the folder. **Must be called from a user gesture on the page**
 * (a click or key press handler, before any `await` that outlasts the activation): the browser
 * shows its prompt only then, and a call from a timer, a promise chain started earlier or a worker
 * resolves 'denied' or stays 'prompt' without showing anything. Resolves 'granted' straight away
 * when access is already held.
 */
export async function requestPermission(handle: FileSystemHandle, mode: 'read' | 'readwrite' = 'read'): Promise<FolderPermission> {
  const h = handle as PermissionedHandle;
  if (typeof h.requestPermission !== 'function') return queryPermission(handle, mode);
  try {
    return await h.requestPermission({ mode });
  } catch {
    // Thrown without user activation (SecurityError) and when the folder no longer exists.
    return queryPermission(handle, mode);
  }
}

/** A stored folder's answer: the browser's three permission states, or 'gone' when it was moved or deleted. */
export type FolderAccess = FolderPermission | 'gone';

/**
 * Whether a folder the page may read is still there. A handle outlives its folder: permission can
 * read 'granted' for a directory that was since moved or deleted, and only listing it tells.
 * Resolves false when the first entry cannot be read; an empty folder is reachable.
 */
export async function folderReachable(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const dir = handle as FileSystemDirectoryHandle & { keys?(): AsyncIterableIterator<string> };
  if (typeof dir.keys !== 'function') return true; // nothing to ask with: reads will tell
  try {
    await dir.keys().next();
    return true;
  } catch {
    return false;
  }
}

/**
 * The probe for a return visit (PLAN.md §12): what a stored directory handle would answer right
 * now, without prompting. 'granted' means it can be listed, not only that the browser allows it.
 */
export async function probeFolder(handle: FileSystemDirectoryHandle): Promise<FolderAccess> {
  const permission = await queryPermission(handle);
  if (permission !== 'granted') return permission;
  return (await folderReachable(handle)) ? 'granted' : 'gone';
}
