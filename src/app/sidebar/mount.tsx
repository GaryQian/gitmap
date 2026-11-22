// Right edge: the sidebar editor (PLAN.md §9, §17.6). Opens when a file is opened (a double-click on
// a sphere sets `openFile`); opaque, because it holds code. While it is closed a small button on the
// top right brings it back with the last file it showed. Contents are read, and saved, through the
// session's ContentSource, so a local folder and a demo look the same from here.
import { useEffect, useMemo } from 'react';
import type { AppMount } from '../../contracts/app';
import { ChatPanel, PANEL_BODY_ID, PanelTabs, closeChatTab, panelTabId, useChatTab } from '../chat';
import { setOpenFile, useApp, useReplica, useSession } from '../store';
import { ChevronLeftIcon, PanelIcon, cx } from '../ui';
import { anyDirty, bindSession, rememberFile, setEmptyOpen, useEdits } from './drafts';
import { resolveTarget } from './files';
import { EmptyReader, Panel, PanelTop, Reader } from './Reader';
import './sidebar.css';

/**
 * The canvas runs full-bleed under the panel, so tell the renderer how much of its right side the
 * panel covers: centring and "Reset view" then frame the map in what is left. The region holds only
 * the panel in its flow (the reopen tab is absolutely placed), so its width is the panel's width.
 */
function useViewInset(): void {
  const render = useApp((s) => s.render);
  useEffect(() => {
    const region = document.querySelector<HTMLElement>('.gm-region-rightEdge');
    if (!render || !region) return;
    let last = -1;
    const report = () => {
      const right = Math.round(region.getBoundingClientRect().width);
      if (right === last) return;
      last = right;
      try { render.setViewInset({ right }); } catch { /* a renderer without it keeps the full width */ }
    };
    report();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(report) : null;
    observer?.observe(region);
    return () => observer?.disconnect();
  }, [render]);
}

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
  useViewInset();

  // With chat available the panel has two tabs, File (everything above) and Chat, and one close button.
  const chat = useChatTab();
  const close = () => { closeChatTab(); setOpenFile(null); setEmptyOpen(false); };
  const panel = chat.active ? <Panel label="Chat" onClose={close}><ChatPanel /></Panel>
    : openFile && target ? <Reader openFile={openFile} target={target} session={session} meta={replica?.meta ?? null} />
    : emptyOpen ? <EmptyReader />
    : null;
  if (!panel || !chat.available) return panel;
  const tab = chat.active ? 'chat' : 'file';
  const fillFileTab = () => { if (!(openFile && target)) reopenFile(replica); };
  const frame = { bar: <PanelTabs active={tab} onFile={fillFileTab} onClose={close} />, tabId: panelTabId(tab), panelId: PANEL_BODY_ID };
  return <PanelTop.Provider value={frame}>{panel}</PanelTop.Provider>;
}

/** Put the last file back in the panel, or the empty reader when there is none. */
function reopenFile(replica: ReturnType<typeof useReplica>): void {
  const { lastFile } = useEdits.getState();
  if (lastFile && resolveTarget(replica, lastFile)) setOpenFile(lastFile);
  else setEmptyOpen(true);
}

/** A tab on the right edge, halfway down: brings the closed panel back. */
function ReopenButton() {
  const openFile = useApp((s) => s.openFile);
  const replica = useReplica();
  const emptyOpen = useEdits((s) => s.emptyOpen);
  const unsaved = useEdits(anyDirty);
  const chatOpen = useChatTab().active;
  if (chatOpen || emptyOpen || (openFile && resolveTarget(replica, openFile))) return null;

  const reopen = () => reopenFile(replica);
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
