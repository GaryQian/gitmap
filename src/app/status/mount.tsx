// Error and empty states of the map screen that belong to no other feature (PLAN.md §12, §17.6):
//   - the line or action for a map that was opened without its folder ("Allow folder access",
//     "Choose the folder"), raised through the store so the top row's notice pills show it;
//   - a small card over the canvas while the graphics context is lost;
//   - "The app was updated" when a part of the app can no longer be fetched.
// The wording is in messages.ts; nothing here is a modal, and nothing takes the focus.
import { useEffect, useState } from 'react';
import type { AppMount } from '../../contracts/app';
import { closeSession } from '../session';
import { dismissStatus, pushNotice, setMessage, useApp, useReplica, useSession } from '../store';
import { Card, PillButton } from '../ui';
import { lineFor, statusLine } from './actions';
import { isStaleBuild } from './classify';
import { folderNeed, useFolderOffers } from './folder';
import { FOLDER_LINE, showFolderLine } from './folderActions';
import { STATUS_LOCAL } from './tunables';
import './status.css';

/**
 * Raises the folder line when the open map has no folder to read from. A saved map says so as soon
 * as it opens; an imported map only once a file is asked for, since its info card and the sidebar
 * already say it. Renders nothing itself.
 */
function FolderWatch() {
  const session = useSession();
  const meta = useReplica()?.meta ?? null;
  const fileOpen = useApp((s) => s.openFile !== null);
  useFolderOffers();
  // the model says whether the map is an import: wait for it before saying anything
  const need = meta ? folderNeed(session, meta) : null;
  const status = need && (need.status !== 'imported-no-folder' || fileOpen) ? need.status : null;

  useEffect(() => {
    if (status) showFolderLine(status);
    else dismissStatus(FOLDER_LINE);
  }, [session, status]);
  return null;
}

/**
 * The graphics context was lost (the GPU process restarted, the driver reset, the tab was starved).
 * The renderer stops drawing and starts again by itself when the browser restores the context; the
 * card says what is happening meanwhile, and offers "Reload" when the context stays lost.
 */
function ContextLost() {
  const lost = useApp((s) => s.contextLost);
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    setWaited(false);
    if (!lost) return;
    const timer = setTimeout(() => setWaited(true), STATUS_LOCAL.contextWaitMs);
    return () => clearTimeout(timer);
  }, [lost]);
  if (!lost) return null;
  const line = lineFor(waited ? 'context-not-restored' : 'context-lost');
  const { action } = line;
  return (
    <div className="gm-status-center">
      <Card blur className="gm-status-card">
        {/* the text is the alert; the card also holds a button, which is not part of the announcement */}
        <p className="gm-status-card-text" role="alert">{line.text}</p>
        {action && <PillButton size="small" className="gm-status-card-action" onClick={() => void action.run()}>{action.label}</PillButton>}
      </Card>
    </div>
  );
}

/**
 * A lazily loaded part of the app that can no longer be fetched means the build was replaced under
 * this tab (or the dev server restarted). Said once: on the landing page as its line, on the map as
 * a line in the top row, and while a map is loading by going back to the landing page with it.
 */
function StaleBuildWatch() {
  useEffect(() => {
    let said = false;
    const say = () => {
      if (said) return;
      said = true;
      const { phase } = useApp.getState();
      if (phase === 'map') { pushNotice(statusLine('app-updated')); return; }
      const line = lineFor('app-updated');
      if (phase === 'waiting') closeSession(line.text, line.action); else setMessage(line.text, line.action);
    };
    const onPreloadError = () => say();
    const onRejection = (e: PromiseRejectionEvent) => { if (isStaleBuild(e.reason)) say(); };
    window.addEventListener('vite:preloadError', onPreloadError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('vite:preloadError', onPreloadError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);
  return null;
}

const mounts: AppMount[] = [
  { region: 'overlay', order: 0, phases: ['landing', 'waiting', 'map'], Component: StaleBuildWatch },
  { region: 'overlay', order: 1, phases: ['waiting', 'map'], Component: FolderWatch },
  { region: 'overlay', order: 20, Component: ContextLost },
];
export default mounts;
