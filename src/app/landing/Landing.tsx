// The landing page (PLAN.md §17.7): the title, one button, and the repo pills other packages mount
// beneath it. The whole page is the drop target; there is no drop-zone box.
import { useEffect, useRef, type ChangeEvent } from 'react';
import { config } from '../../config';
import type { RepoSource } from '../../contracts/pipeline';
import { Region } from '../mounts';
import { closeSession, openSource } from '../session';
import { setBackgroundEmphasis, setMessage, useApp } from '../store';
import { PillButton } from '../ui';
import {
  AcquireError, canPickDirectory, canUseFolderInput, captureDrop, MESSAGES, pickDirectory, sourceFromDrop, sourceFromFileList,
} from './acquire';

const messageFor = (err: unknown): string => (err instanceof AcquireError ? err.message : MESSAGES.unreadable);

/** Run one way of getting a source; open it, or put the reason it failed under the button. */
async function acquire(get: () => Promise<RepoSource | null> | RepoSource | null): Promise<void> {
  setMessage(null);
  let source: RepoSource | null;
  try {
    source = await get();
  } catch (err) {
    closeSession(messageFor(err));
    return;
  }
  if (source) await openSource(source);
}

const hasFiles = (e: DragEvent): boolean => Array.from(e.dataTransfer?.types ?? []).includes('Files');

export function Landing() {
  const message = useApp((s) => s.message);
  const input = useRef<HTMLInputElement>(null);
  const supported = canPickDirectory() || canUseFolderInput();

  useEffect(() => {
    // React has no prop for this attribute
    input.current?.setAttribute('webkitdirectory', '');
  }, []);

  useEffect(() => {
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
        if (!dropped) throw new AcquireError(MESSAGES.notAFolder);
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
  }, []);

  const choose = () => {
    if (canPickDirectory()) void acquire(pickDirectory);
    else if (canUseFolderInput()) input.current?.click();
    else setMessage(MESSAGES.unsupported);
  };

  const onPicked = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ''; // so choosing the same folder again fires a change
    if (files.length > 0) void acquire(() => sourceFromFileList(files));
  };

  return (
    <main className="gm-landing">
      <h1 className="gm-title">{config.app.title}</h1>
      <PillButton size="large" blur onClick={choose}>Choose a folder</PillButton>
      <p className="gm-message" role="status">{message ?? (supported ? '' : MESSAGES.unsupported)}</p>
      <Region name="landing" />
      <input ref={input} className="gm-file-input" type="file" multiple tabIndex={-1} aria-hidden="true" onChange={onPicked} />
    </main>
  );
}
