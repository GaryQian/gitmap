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
export async function queryPermission(handle: FileSystemHandle): Promise<FolderPermission> {
  const h = handle as PermissionedHandle;
  if (typeof h.queryPermission !== 'function') return 'granted';
  try {
    return await h.queryPermission({ mode: 'read' });
  } catch {
    return 'denied';
  }
}

/**
 * Ask the user for read access to the folder. **Must be called from a user gesture on the page**
 * (a click or key press handler, before any `await` that outlasts the activation): the browser
 * shows its prompt only then, and a call from a timer, a promise chain started earlier or a worker
 * resolves 'denied' or stays 'prompt' without showing anything. Resolves 'granted' straight away
 * when access is already held.
 */
export async function requestPermission(handle: FileSystemHandle): Promise<FolderPermission> {
  const h = handle as PermissionedHandle;
  if (typeof h.requestPermission !== 'function') return queryPermission(handle);
  try {
    return await h.requestPermission({ mode: 'read' });
  } catch {
    // Thrown without user activation (SecurityError) and when the folder no longer exists.
    return queryPermission(handle);
  }
}
