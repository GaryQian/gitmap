// The landing page (PLAN.md §17.7): the title, one button, and the repo pills other packages mount
// beneath it. The whole page is the drop target; there is no drop-zone box. Messages appear only when
// needed, as one quiet line under the button; every sentence is in ../status/messages.ts.
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { config } from '../../config';
import type { RepoSource } from '../../contracts/pipeline';
import { Region } from '../mounts';
import { savedRepos } from '../repos/registry';
import { closeSession, openSource } from '../session';
import { lineFor } from '../status/actions';
import { say } from '../status/messages';
import { browserSupport, supportVerdict } from '../status/support';
import '../status/status.css';
import { setBackgroundEmphasis, setMessage, useApp } from '../store';
import { PillButton } from '../ui';
import { About } from './About';
import { AcquireError, captureDrop, pickDirectory, sourceFromDrop, sourceFromFileList } from './acquire';

/** Run one way of getting a source; open it, or put the reason it failed under the button. */
async function acquire(get: () => Promise<RepoSource | null> | RepoSource | null): Promise<void> {
  setMessage(null);
  let source: RepoSource | null;
  try {
    source = await get();
  } catch (err) {
    if (!(err instanceof AcquireError)) console.warn('starmap: the folder could not be opened', err);
    closeSession(lineFor(err instanceof AcquireError ? err.status : 'folder-unreadable').text);
    return;
  }
  if (source) await openSource(source);
}

const hasFiles = (e: DragEvent): boolean => Array.from(e.dataTransfer?.types ?? []).includes('Files');

/** False once it is known that nothing outlives this page (private browsing, storage denied). */
function useRemembers(): boolean {
  const [remembers, setRemembers] = useState(true);
  useEffect(() => {
    let live = true;
    void savedRepos().then((repos) => { if (live) setRemembers(repos.remembers); });
    return () => { live = false; };
  }, []);
  return remembers;
}

export function Landing() {
  const message = useApp((s) => s.message);
  const action = useApp((s) => s.messageAction);
  // a hint about this browser is said once per visit: until the first map has been opened
  const firstLook = useApp((s) => s.sessionId === 0);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const support = browserSupport();
  const verdict = supportVerdict(support);
  const remembers = useRemembers();

  useEffect(() => {
    // React has no prop for this attribute
    input.current?.setAttribute('webkitdirectory', '');
  }, []);

  useEffect(() => {
    if (!verdict.usable) return; // nothing a dropped folder could become
    let depth = 0; // dragenter and dragleave fire for every element the pointer crosses
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (++depth === 1) setBackgroundEmphasis(1);
    };
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setBackgroundEmphasis(0);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setBackgroundEmphasis(0);
      const dropped = captureDrop(e.dataTransfer); // before the handler returns
      void acquire(() => {
        if (!dropped) throw new AcquireError('not-a-folder');
        // walking a big dropped folder takes a while in browsers without directory handles: say so
        return sourceFromDrop(dropped, (n) => {
          useApp.setState({ phase: 'waiting', stage: { stage: 'manifest', label: `Listing files ${n.toLocaleString()}` } });
        });
      });
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
      setBackgroundEmphasis(0);
    };
  }, [verdict.usable]);

  const choose = () => {
    if (support.picker) void acquire(pickDirectory);
    else input.current?.click();
  };

  const onPicked = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ''; // so choosing the same folder again fires a change
    if (files.length > 0) void acquire(() => sourceFromFileList(files));
  };

  const act = async () => {
    if (!action) return;
    setBusy(true);
    try { await action.run(); } catch (err) { console.warn(`starmap: "${action.label}" failed`, err); }
    setBusy(false);
  };

  // One line at most. Something that just happened comes first; then what this browser cannot do at
  // all, which stays; then, once per visit, what it will not remember.
  const hint =
    !verdict.usable && verdict.line ? say(verdict.line.id, verdict.line.params).text
    : !firstLook ? ''
    : !remembers ? say('storage-memory').text
    : verdict.line ? say(verdict.line.id, verdict.line.params).text
    : '';

  return (
    <main className="gm-landing">
      <About />
      <h1 className="gm-title">{config.app.title}</h1>
      {verdict.canChoose && <PillButton size="large" blur onClick={choose}>Choose a folder</PillButton>}
      <p className="gm-message" role="status">
        {message ?? hint}
        {message !== null && action && (
          <button type="button" className="gm-message-action" disabled={busy} onClick={() => void act()}>{action.label}</button>
        )}
      </p>
      {verdict.usable && <Region name="landing" />}
      <input ref={input} className="gm-file-input" type="file" multiple tabIndex={-1} aria-hidden="true" onChange={onPicked} />
    </main>
  );
}
