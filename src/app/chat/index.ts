// The chat assistant in the chrome (PLAN.md §11.5): the "Chat" pill at the bottom centre (mount.tsx),
// the Chat tab of the side panel, and the tools the assistant drives the map with (tools/). This is
// what other packages may call or render; the sidebar is the one that does.
export { ChatPanel } from './ChatPanel';
export { PANEL_BODY_ID, PanelTabs, panelTabId } from './PanelTabs';
export type { PanelTabsProps } from './PanelTabs';
export { useChatAvailable, useChatTab } from './available';
export { closeChatTab, showChatTab, showFileTab, usePanel } from './panel';
export type { PanelTab } from './panel';
export { newChat, sendMessage, setChatClient, stopTurn, useChat } from './state';
export { createToolExecutor } from './tools/executor';
export { liveEnv } from './tools/live';
// For the dev harness and browser checks: a transport that plays a script instead of calling the server.
export { createScriptedClient } from './scripted';
export type { Script, ScriptedStep } from './scripted';
