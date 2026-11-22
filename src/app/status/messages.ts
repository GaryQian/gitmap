// Every sentence the shell shows for a failure, an empty case or a missing capability, in one place
// so the copy can be read and changed together (PLAN.md §17.1: sentence case, plain verbs; §17.7:
// one quiet line). A case says what happened and, where there is one, the next step; the optional
// action is the one thing the viewer can do about it. Nothing here touches the DOM.
//
// The AI lines are not here: they belong to `describeAiError` in src/ai/client/errors.ts, which the
// worker and the chrome share.

export type StatusActionId = 'reload' | 'choose-folder' | 'allow-folder' | 'remove-saved';

export interface StatusMessage {
  text: string;
  /** What the viewer can do about it. The caller supplies what the action runs (see actions.ts). */
  action?: { id: StatusActionId; label: string };
}

export interface StatusParams {
  /** A repo, demo or folder name. */
  name?: string;
  /** The missing capabilities, already joined ("WebGL 2 and web workers"). */
  what?: string;
  /** A formatted count ("200,000 files"). */
  limit?: string;
}

const RELOAD = { id: 'reload', label: 'Reload' } as const;
const CHOOSE = { id: 'choose-folder', label: 'Choose the folder' } as const;
const ALLOW = { id: 'allow-folder', label: 'Allow folder access' } as const;
const REMOVE = { id: 'remove-saved', label: 'Remove it' } as const;

const named = (name: string | undefined, fallback: string): string => (name ? name : fallback);

const SENTENCES = {
  // ---- 1. browser support (landing page) ----
  'browser-no-folders': () => ({ text: 'This browser has no folder dialog. Drop a folder onto the page instead.' }),
  'browser-missing': (p) => ({ text: `This browser lacks ${named(p.what, 'a feature')}, which Starmap needs. Try a current desktop version of Chrome, Edge, Firefox or Safari.` }),
  'folder-not-remembered': () => ({ text: 'This browser cannot remember the folder between visits. Choose it again next time.' }),

  // ---- 2. the chosen folder (landing page) ----
  'folder-denied': () => ({ text: 'The browser did not allow access to that folder.' }),
  'folder-empty': () => ({ text: 'That folder is empty.' }),
  'folder-nothing-to-map': () => ({ text: 'That folder has no files the map can show. Everything in it is ignored or excluded.' }),
  'folder-unreadable': () => ({ text: 'That folder could not be read.' }),
  'folder-read-stopped': () => ({ text: 'That folder could not be read all the way through. Check that it is still there and try again.' }),
  'folder-too-large': (p) => ({ text: `That folder holds more than ${named(p.limit, 'the largest number of files')} Starmap can list. Choose a smaller folder, or add a .gitignore that leaves out generated files.` }),
  'not-a-folder': () => ({ text: 'That is a file, not a folder. Drop a folder, or an exported archive (.starmap.zip or .starmap.json.gz).' }),
  'saved-map-unreadable': () => ({ text: 'That file could not be read as a saved map. It may be damaged or cut short.' }),
  'saved-map-other-version': () => ({ text: 'That saved map was made by another version of Starmap and cannot be opened here.' }),

  // ---- 3. no history (map, one line) ----
  'no-history-plain-folder': () => ({ text: 'History overlays are unavailable: this folder is not a git repository.' }),
  'no-history-worktree': () => ({ text: 'History overlays are unavailable: this is a linked worktree, and its history is kept in another folder.' }),
  'no-history-index': () => ({ text: 'History overlays are unavailable: this repository uses a git index format Starmap cannot read.' }),
  'no-history-sha256': () => ({ text: 'History overlays are unavailable: SHA-256 repositories are not supported.' }),
  'no-history-empty': () => ({ text: 'History overlays are unavailable: this repository has no commits yet.' }),
  'no-history': () => ({ text: 'History overlays are unavailable: the history of this folder could not be read.' }),

  // ---- 4. return visits and folder permission ----
  'folder-allow': () => ({ text: 'Viewing files needs access to the folder', action: ALLOW }),
  'folder-needed': () => ({ text: 'File contents and updates are unavailable until the folder is chosen again.', action: CHOOSE }),
  'folder-gone': () => ({ text: 'The folder has moved or been deleted. Choose it again to view files and check for changes.', action: CHOOSE }),
  'folder-not-allowed': () => ({ text: 'Folder access was not allowed. Choose the folder again to view files and check for changes.', action: CHOOSE }),
  'folder-mismatch': (p) => ({ text: `That folder does not look like ${named(p.name, 'the one this map was made from')}. Choose the folder this map was made from.`, action: CHOOSE }),
  'imported-no-folder': () => ({ text: 'Files of an imported map are unavailable until its folder is chosen.', action: CHOOSE }),
  'saved-map-gone': (p) => ({ text: `The saved map of ${named(p.name, 'that repo')} can no longer be opened, and its folder is not available. Choose the folder to map it again.`, action: REMOVE }),
  'saved-list-unavailable': () => ({ text: 'The saved maps could not be listed.' }),

  // ---- 5. during the parse ----
  'app-updated': () => ({ text: 'The app was updated. Reload the page to continue.', action: RELOAD }),
  'worker-failed': () => ({ text: 'A background worker stopped, so the map could not be built. Reload the page and try again.', action: RELOAD }),
  'map-out-of-step': () => ({ text: 'The map fell out of step with its data. Reload the page to continue.', action: RELOAD }),
  'map-failed': () => ({ text: 'The map could not be built. Try again.' }),
  // non-fatal: one line on the map that fades
  'background-work-stopped': () => ({ text: 'Some background work stopped early. The map is still usable.' }),
  'history-stopped': () => ({ text: 'Reading the history stopped early, so the history overlays may be incomplete.' }),
  'calls-stopped': () => ({ text: 'Call analysis stopped early, so some connections may be missing.' }),
  'changes-unchecked': () => ({ text: 'The folder could not be checked for edited files.' }),
  'apply-failed': () => ({ text: 'The refined structure could not be applied. The map is unchanged.' }),
  'update-failed': () => ({ text: 'The changed files could not be applied. The map is unchanged.' }),
  'still-working': () => ({ text: 'Still working. Large folders take a while.' }),

  // ---- 6. WebGL ----
  'webgl-unavailable': () => ({ text: 'This browser could not start WebGL, which the map needs.' }),
  'map-not-drawn': () => ({ text: 'The map could not be drawn. Reload the page and try again.', action: RELOAD }),
  'context-lost': () => ({ text: 'The graphics context was lost. Waiting for it to come back.' }),
  'context-not-restored': () => ({ text: 'The graphics context was lost and has not come back. Reload the page to continue.', action: RELOAD }),

  // ---- 7. demo and imported maps ----
  'demo-unavailable': (p) => ({ text: `The demo ${named(p.name, 'map')} could not be loaded. Check the connection and try again.` }),
  'export-failed': () => ({ text: 'This map cannot be exported.' }),

  // ---- 9. storage ----
  'storage-memory': () => ({ text: 'This window is not keeping storage, so maps will not be remembered here.' }),
  'save-failed': () => ({ text: 'This map could not be saved for next time. The browser may be out of storage.' }),
} satisfies Record<string, (p: StatusParams) => StatusMessage>;

export type StatusCase = keyof typeof SENTENCES;

/** Every case, for the copy review and the tests. */
export const STATUS_CASES = Object.keys(SENTENCES) as StatusCase[];

/** The sentence, and the action if there is one, for a case. */
export function say(id: StatusCase, params: StatusParams = {}): StatusMessage {
  return SENTENCES[id](params);
}

/** "a", "a and b", "a, b and c". */
export function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
