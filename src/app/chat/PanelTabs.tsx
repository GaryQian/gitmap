// The tab bar at the top of the side panel once chat is available: File and Chat, and at its end
// the panel's one close button. The sidebar renders it above whichever tab is showing; the tabs
// follow the ARIA tabs pattern (arrow keys move and switch, one tab stop).
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { CloseIcon, PillButton, cx } from '../ui';
import { showChatTab, showFileTab, takeFocus, takeSwitching, type FocusTarget, type PanelTab } from './panel';
import { newChat, useChat } from './state';

export interface PanelTabsProps {
  active: PanelTab;
  /** Put something in the File tab if nothing is (the last file, or the empty reader). */
  onFile: () => void;
  /** Close the whole panel, whichever tab is showing. */
  onClose: () => void;
}

const TABS: readonly { id: PanelTab; label: string }[] = [{ id: 'file', label: 'File' }, { id: 'chat', label: 'Chat' }];

/** The element the sidebar wraps a tab's content in: the tab panel both tabs control. */
export const PANEL_BODY_ID = 'gm-panel-body';
export const panelTabId = (tab: PanelTab): string => `gm-panel-tab-${tab}`;

export function PanelTabs({ active, onFile, onClose }: PanelTabsProps) {
  const row = useRef<HTMLDivElement>(null);
  // This bar came with the other tab's panel, in the place of the one that just went: no slide-in.
  const [replaced] = useState(takeSwitching);
  const answering = useChat((s) => s.transcript.running);
  const hasConversation = useChat((s) => s.transcript.items.length > 0);

  // A switch made from the keyboard keeps the focus on the tab. The panel takes the focus for
  // itself as it opens, so wait a frame.
  useEffect(() => {
    if (!takeFocus('tab')) return;
    const frame = requestAnimationFrame(() => row.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, []);

  const pick = (tab: PanelTab, focus: FocusTarget | null) => {
    if (tab === active) return;
    if (tab === 'chat') { showChatTab(focus); return; }
    showFileTab(focus);
    onFile();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = TABS.findIndex((t) => t.id === active);
    const next =
      e.key === 'ArrowRight' ? (at + 1) % TABS.length
      : e.key === 'ArrowLeft' ? (at - 1 + TABS.length) % TABS.length
      : e.key === 'Home' ? 0
      : e.key === 'End' ? TABS.length - 1
      : -1;
    if (next < 0 || e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    pick(TABS[next]!.id, 'tab');
  };

  return (
    <div className={cx('gm-panel-tabs', replaced && 'is-replacing')}>
      <div className="gm-panel-tablist" role="tablist" aria-label="Side panel" ref={row} onKeyDown={onKeyDown}>
        {TABS.map((tab) => {
          const selected = tab.id === active;
          const busy = tab.id === 'chat' && answering && !selected;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={panelTabId(tab.id)}
              aria-selected={selected}
              // one panel element holds whichever tab is showing, so only that tab controls it
              aria-controls={selected ? PANEL_BODY_ID : undefined}
              tabIndex={selected ? 0 : -1}
              className={cx('gm-panel-tab', selected && 'is-active')}
              onClick={() => pick(tab.id, tab.id === 'chat' ? 'composer' : null)}
            >
              {tab.label}
              {busy && <span className="gm-panel-tab-busy" role="img" aria-label="answering" />}
            </button>
          );
        })}
      </div>
      {active === 'chat' && hasConversation && (
        <PillButton size="small" className="gm-panel-action" title="Clear this conversation and start another" onClick={newChat}>
          New chat
        </PillButton>
      )}
      <PillButton round size="small" className="gm-panel-close" aria-label="Close the panel" title="Close (Esc)" onClick={onClose}>
        <CloseIcon size={14} />
      </PillButton>
    </div>
  );
}
