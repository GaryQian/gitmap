// Which tab the side panel shows, File or Chat, and where the focus should land after a switch. Its
// own small store because the sidebar, the chat button and the tools all turn the tab.
import { create } from 'zustand';
import { useApp } from '../store';

export type PanelTab = 'file' | 'chat';
/** Where the focus goes once the tab is on screen: the composer, or the tab itself (arrow keys). */
export type FocusTarget = 'composer' | 'tab';

interface PanelState {
  /** 'chat' means the Chat tab is open. 'file' is the panel as it was before chat: open when a file is. */
  tab: PanelTab;
  /** Goes up each time the composer is asked to take the focus. */
  composerFocus: number;
}

export const usePanel = create<PanelState>()(() => ({ tab: 'file', composerFocus: 0 }));

let pendingFocus: FocusTarget | null = null;
/** The switch in progress came from one tab to the other, so the panel is already open. */
let switching = false;

/** Open the panel on the Chat tab. */
export function showChatTab(focus: FocusTarget | null = 'composer'): void {
  const was = usePanel.getState().tab;
  pendingFocus = focus;
  switching = was !== 'chat' && panelIsOpen();
  usePanel.setState((s) => ({ tab: 'chat', composerFocus: focus === 'composer' ? s.composerFocus + 1 : s.composerFocus }));
}

/** Turn to the File tab. Whether a file is in it is the sidebar's business. */
export function showFileTab(focus: FocusTarget | null = null): void {
  if (usePanel.getState().tab === 'file') return;
  pendingFocus = focus;
  switching = true;
  usePanel.setState({ tab: 'file' });
}

/** The Chat tab is closed with the panel: no switch, nothing to focus. */
export function closeChatTab(): void {
  pendingFocus = null;
  switching = false;
  if (usePanel.getState().tab !== 'file') usePanel.setState({ tab: 'file' });
}

/** The focus the last switch asked for, handed over once. */
export function takeFocus(target: FocusTarget): boolean {
  if (pendingFocus !== target) return false;
  pendingFocus = null;
  return true;
}

/** Whether the panel now mounting replaces the other tab (so it should not slide in again). Read once. */
export function takeSwitching(): boolean {
  const was = switching;
  switching = false;
  return was;
}

function panelIsOpen(): boolean {
  return typeof document !== 'undefined' && document.querySelector('.gm-sidebar') !== null;
}

// A file opened from the map (a double-click, the assistant's open_file) shows on the File tab; a
// new map starts with the panel as it always was.
const unsubscribe = useApp.subscribe((s, prev) => {
  if (s.session !== prev.session) usePanel.setState({ tab: 'file' });
  else if (s.openFile !== prev.openFile && s.openFile !== null) showFileTab();
});
if (import.meta.hot) import.meta.hot.dispose(unsubscribe);

// This module holds state. Hot-swapping it would leave two copies alive, so reload the page instead.
if (import.meta.hot) import.meta.hot.accept(() => location.reload());
