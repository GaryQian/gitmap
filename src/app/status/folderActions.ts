// "Allow folder access" and "Choose the folder": giving an open map its folder back (PLAN.md §12).
// Both must be called from a click or a key press: the browser shows its permission prompt and its
// folder dialog only then.
import type { RepoLocator } from '../../contracts/git';
import { folderReachable, requestPermission } from '../../persist';
import { AcquireError, chooseDirectory, folderHasAnyOf } from '../landing/acquire';
import { savedRepos } from '../repos/registry';
import { reopenWithFolder } from '../session';
import { dismissStatus, pushNotice, useApp } from '../store';
import { statusLine, type ActionRunners } from './actions';
import { folderOffer, offerFolder } from './folder';
import type { StatusCase, StatusParams } from './messages';

/** The one line about the open map's folder; a newer one replaces it. */
export const FOLDER_LINE = 'folder';
/** A try at choosing a folder that did not work out: said once, then gone. */
const PICK_LINE = 'folder-pick';

export const folderRunners: ActionRunners = {
  'allow-folder': () => allowFolder(),
  'choose-folder': () => chooseFolder(),
};

/** Put the line for the folder's state in the map's top row. */
export function showFolderLine(status: StatusCase, params?: StatusParams): void {
  pushNotice(statusLine(status, { key: FOLDER_LINE, params, runners: folderRunners }));
}

/**
 * "Allow folder access": ask the browser for the stored folder, first thing, then open the same map
 * with it. When the browser says no, or the folder is no longer there, the line says so and offers
 * "Choose the folder" instead.
 */
export async function allowFolder(): Promise<void> {
  const { session } = useApp.getState();
  if (!session) return;
  const offer = folderOffer(session.source);
  if (!offer?.root) { await chooseFolder(); return; }
  const { root } = offer;
  const answer = await requestPermission(root); // nothing is awaited before this: the gesture is still live
  if (useApp.getState().session !== session) return;
  if (answer === 'prompt') return; // the browser's prompt was closed without an answer: the offer stands
  if (answer === 'denied') {
    offerFolder(session.source, { ...offer, state: 'denied' });
    return;
  }
  if (!(await folderReachable(root))) {
    if (useApp.getState().session === session) offerFolder(session.source, { ...offer, state: 'gone' });
    return;
  }
  if (useApp.getState().session !== session) return;
  dismissStatus(FOLDER_LINE);
  await reopenWithFolder({ kind: 'fsa', root });
}

/**
 * "Choose the folder": the folder dialog (or the folder input, where there is no dialog), a quick
 * check that the folder holds this map's files, then the same map opened with it. A saved repo keeps
 * the new folder for the next visit.
 */
export async function chooseFolder(): Promise<void> {
  const { session } = useApp.getState();
  if (!session) return;
  let locator: RepoLocator | null;
  try {
    locator = await chooseDirectory();
  } catch (err) {
    console.warn('starmap: no folder was chosen', err);
    pushNotice(statusLine(err instanceof AcquireError ? err.status : 'folder-unreadable', { key: PICK_LINE, fades: true }));
    return;
  }
  if (!locator || useApp.getState().session !== session) return;
  dismissStatus(PICK_LINE);

  const files = session.replica.table('file');
  const paths: string[] = [];
  for (const slot of files.slots()) paths.push(files.ids[slot]!);
  if (!(await folderHasAnyOf(locator, paths))) {
    if (useApp.getState().session === session) showFolderLine('folder-mismatch', { name: session.replica.meta?.name });
    return;
  }
  if (useApp.getState().session !== session) return;

  const offer = folderOffer(session.source);
  if (offer?.repoId && locator.kind === 'fsa') {
    const { root } = locator;
    const id = offer.repoId;
    await savedRepos().then((repos) => repos.rememberFolder(id, root)).catch((err: unknown) => {
      console.warn('starmap: the chosen folder could not be kept for the next visit', err);
    });
  }
  dismissStatus(FOLDER_LINE);
  await reopenWithFolder(locator);
}
