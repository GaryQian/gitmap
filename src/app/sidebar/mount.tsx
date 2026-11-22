// Right edge: the sidebar editor (PLAN.md §9, §17.6). Opens when a file is opened (a double-click on
// a sphere sets `openFile`); opaque, because it holds code. While it is closed a small button on the
// top right brings it back with the last file it showed. Contents are read, and saved, through the
// session's ContentSource, so a local folder and a demo look the same from here.
import { useEffect, useMemo } from 'react';
import type { AppMount } from '../../contracts/app';
import { setOpenFile, useApp, useReplica, useSession } from '../store';
import { ChevronLeftIcon, PanelIcon, cx } from '../ui';
import { anyDirty, bindSession, rememberFile, setEmptyOpen, useEdits } from './drafts';
import { resolveTarget } from './files';
import { EmptyReader, Reader } from './Reader';
import './sidebar.css';

function Sidebar() {
  const openFile = useApp((s) => s.openFile);
  const session = useSession();
  const replica = useReplica();
  const rev = replica?.rev ?? 0;
  const emptyOpen = useEdits((s) => s.emptyOpen);
  // `rev` is a dependency on purpose: the replica object stays the same while its tables change
  const target = useMemo(() => (openFile ? resolveTarget(replica, openFile) : null), [replica, rev, openFile]);

  useEffect(() => { bindSession(session); }, [session]);
  useEffect(() => { if (openFile && target) rememberFile(openFile); }, [openFile, target]);

  if (openFile && target) return <Reader openFile={openFile} target={target} session={session} meta={replica?.meta ?? null} />;
  if (emptyOpen) return <EmptyReader />;
  return null;
}

/** A tab on the right edge, halfway down: brings the closed panel back. */
function ReopenButton() {
  const openFile = useApp((s) => s.openFile);
  const replica = useReplica();
  const lastFile = useEdits((s) => s.lastFile);
  const emptyOpen = useEdits((s) => s.emptyOpen);
  const unsaved = useEdits(anyDirty);
  if (emptyOpen || (openFile && resolveTarget(replica, openFile))) return null;

  const reopen = () => {
    const back = lastFile && resolveTarget(replica, lastFile) ? lastFile : null;
    if (back) setOpenFile(back);
    else setEmptyOpen(true);
  };
  return (
    <button
      type="button"
      className={cx('gm-reader-handle', 'gm-blur', unsaved && 'has-unsaved')}
      aria-label={unsaved ? 'Show the file panel (unsaved changes)' : 'Show the file panel'}
      title="Show the file panel"
      onClick={reopen}
    >
      <ChevronLeftIcon size={18} />
      <PanelIcon size={22} />
      {unsaved && <span className="gm-reader-dirty gm-reader-handle-dot" aria-hidden="true" />}
    </button>
  );
}

const mounts: AppMount[] = [
  { region: 'rightEdge', order: 0, Component: Sidebar },
  { region: 'rightEdge', order: 1, Component: ReopenButton },
];
export default mounts;
