// Bottom centre: the "Chat" pill (PLAN.md §11.5, §17.6). It exists once AI is enabled for the repo
// and opens the side panel on its Chat tab, with the focus in the composer. The tab itself is
// rendered by the sidebar (src/app/sidebar/mount.tsx) from <ChatPanel /> and <PanelTabs />.
import type { AppMount } from '../../contracts/app';
import { PillButton } from '../ui';
import { useChatAvailable } from './available';
import { SpeechIcon } from './icons';
import { showChatTab, usePanel } from './panel';
import './chat.css';

function ChatButton() {
  const available = useChatAvailable();
  const open = usePanel((s) => s.tab === 'chat');
  if (!available) return null;
  return (
    <PillButton
      blur
      size="large"
      className="gm-chat-button"
      active={open}
      aria-expanded={open}
      title={open ? 'Go to the chat' : 'Ask the assistant about this repo'}
      onClick={() => showChatTab('composer')}
    >
      <SpeechIcon size={21} />
      Chat
    </PillButton>
  );
}

// After the tour pill (10): the region is a column, so "Tour the repo" sits above the chat pill.
const mount: AppMount = { region: 'bottomCenter', order: 11, Component: ChatButton };
export default mount;
