// Turning what went wrong into one of the cases of messages.ts. The pipeline, the workers and the
// browser report failures as strings and exceptions written for a console; nothing of that wording
// reaches the screen. Each function here is pure: a message or an error in, a case out.
import type { StatusCase, StatusParams } from './messages';

export interface Classified { id: StatusCase; params?: StatusParams }

const text = (err: unknown): string =>
  typeof err === 'string' ? err : err instanceof Error ? `${err.name}: ${err.message}` : String((err as { message?: unknown } | null)?.message ?? err ?? '');
const nameOf = (err: unknown): string =>
  typeof err === 'object' && err !== null && typeof (err as { name?: unknown }).name === 'string' ? (err as { name: string }).name : '';

// ---- stale build ----

/**
 * A module the page asked for is no longer on the server: the dev server restarted or re-optimised
 * its dependencies, or a new build replaced the hashed files of the one this tab loaded. Each engine
 * words it differently; the pool adds its own when a worker script will not load.
 */
const STALE_BUILD = [
  /dynamically imported module/i, // Chromium "Failed to fetch…", Firefox "error loading…"
  /importing a module script failed/i, // Safari
  /module script.*(failed|mime type)/i,
  /script could not be loaded/i, // src/compute/workerPool.ts
  /outdated optimize dep/i, // vite, after it re-bundled dependencies
  /unable to preload css/i, // vite preload helper
  /failed to load module script/i,
];

export function isStaleBuild(message: unknown): boolean {
  const m = text(message);
  return STALE_BUILD.some((re) => re.test(m));
}

/** A worker that died or never started, for a reason other than a missing script. */
const WORKER_FAILED = [
  /background worker stopped/i, // src/pipeline/session.ts, a worker error with no message
  /compute worker \d+ (failed|is not running|sent a message)/i, // src/compute/workerPool.ts
  /pool disposed/i,
  /\bworker\b.*\b(terminated|crashed|could not be (started|created))/i,
];

// ---- a fatal failure while opening or parsing ----

export interface FailureContext {
  /** What was being opened. */
  kind?: 'directory' | 'snapshot' | 'demo' | 'synthetic';
  /** The demo's name, when it is one. */
  name?: string;
}

/**
 * The case for a failure that ended a map before it was shown (`error` with `fatal: true`, a
 * rejected `start()`, a session that could not be created).
 */
export function classifyFatal(err: unknown, ctx: FailureContext = {}): Classified {
  const m = text(err);
  if (isStaleBuild(m)) return { id: 'app-updated' };
  if (WORKER_FAILED.some((re) => re.test(m))) return { id: 'worker-failed' };
  if (/fell out of step/i.test(m)) return { id: 'map-out-of-step' };
  if (/webgl|creating.*context/i.test(m)) return { id: 'webgl-unavailable' };
  // whatever else happened to a demo, the viewer chose a demo and it did not open
  if (ctx.kind === 'demo') return { id: 'demo-unavailable', params: { name: ctx.name } };
  if (ctx.kind === 'snapshot') return { id: /unsupported starmap schema|cannot load a model with schema/i.test(m) ? 'saved-map-other-version' : 'map-failed' };

  if (/no files to map/i.test(m)) return { id: 'folder-nothing-to-map' };
  const limit = /holds more than ([\d.,\s]+(?:files|folders))/i.exec(m);
  if (limit) return { id: 'folder-too-large', params: { limit: limit[1]!.trim() } };
  if (/NotAllowedError|SecurityError|not allowed by the user agent|permission/i.test(m)) return { id: 'folder-denied' };
  if (/NotFoundError|NotReadableError|InvalidStateError|could not be found|cannot read \.git|could not be read|changed on disk|^(\w+: )?git: /i.test(m)) {
    return { id: 'folder-read-stopped' };
  }
  return { id: ctx.kind === 'directory' ? 'folder-unreadable' : 'map-failed' };
}

/** The folder dialog or a drop failed. Null for a dialog the viewer closed: that is not a failure. */
export function classifyPickError(err: unknown): StatusCase | null {
  const name = nameOf(err);
  if (name === 'AbortError') return null;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'folder-denied';
  return 'folder-unreadable';
}

// ---- a dropped saved map ----

/**
 * Why a `.starmap.json.gz` did not open, by the decoder's own distinction (src/model/codec.ts):
 * "Unsupported starmap schema N" for a file of another version, "Not a starmap file" for the rest.
 */
export function classifyDecodeError(err: unknown): 'saved-map-other-version' | 'saved-map-unreadable' {
  return /unsupported starmap schema/i.test(text(err)) ? 'saved-map-other-version' : 'saved-map-unreadable';
}

// ---- no history ----

/**
 * The reason the shell puts in place of the pipeline's when its own probe finds a `.git` that is a
 * file: a linked worktree or a submodule, which the manifest reports as a folder with no repository.
 */
export const WORKTREE_REASON = 'This folder is a linked worktree: its .git is a file.';

/**
 * Why the history overlays have nothing to show, from the reason the manifest or the history walk
 * gave (or `WORKTREE_REASON`).
 */
export function classifyNoHistory(reason: string): StatusCase {
  if (/linked worktree|\.git is a file/i.test(reason)) return 'no-history-worktree';
  if (/sha-?256/i.test(reason)) return 'no-history-sha256';
  if (/no commits/i.test(reason) || /lists no files/i.test(reason)) return 'no-history-empty';
  if (/not a git repository|no \.git directory/i.test(reason)) return 'no-history-plain-folder';
  if (/git index|sparse|split index/i.test(reason)) return 'no-history-index';
  return 'no-history';
}

// ---- non-fatal lines on the map ----

/**
 * The case for a non-fatal `error` event or an `info` notice. The pipeline's messages start with its
 * own sentence and end with whatever the exception said; only the start is used.
 */
export function classifyBackground(message: string): StatusCase {
  if (isStaleBuild(message)) return 'app-updated';
  if (/could not be saved for next time/i.test(message)) return 'save-failed';
  if (/history (walk|overlays)/i.test(message)) return 'history-stopped';
  if (/call analysis/i.test(message)) return 'calls-stopped';
  if (/could not be checked for edited files/i.test(message)) return 'changes-unchecked';
  return 'background-work-stopped';
}

// ---- folder permission ----

/** What a stored folder handle answers: the browser's three states, or a folder that is no longer there. */
export type FolderState = 'granted' | 'prompt' | 'denied' | 'gone';

/** The line or action a saved map shows for its folder; null when the folder is readable. */
export function folderCase(state: FolderState | 'none', imported = false): StatusCase | null {
  switch (state) {
    case 'granted': return null;
    case 'prompt': return 'folder-allow';
    case 'denied': return 'folder-not-allowed';
    case 'gone': return 'folder-gone';
    case 'none': return imported ? 'imported-no-folder' : 'folder-needed';
  }
}
