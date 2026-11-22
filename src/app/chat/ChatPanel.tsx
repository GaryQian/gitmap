// The Chat tab of the side panel: a scrolling transcript and a composer (PLAN.md §11.5). The panel
// around it (width, resize handle, tab bar, close, Escape) belongs to the sidebar; this is its content.
import { useEffect, useId, useLayoutEffect, useRef, type KeyboardEvent, type MouseEvent } from 'react';
import { fileRef } from '../../model/types';
import { setSelection, useReducedMotion, useRepoName } from '../store';
import { PillButton, cx } from '../ui';
import { Answer, preloadMarkdown } from './Answer';
import { SendIcon, StopIcon } from './icons';
import { takeFocus, usePanel } from './panel';
import { retryTurn, sendMessage, setDraft, stopTurn, useChat } from './state';
import { liveEnv } from './tools/live';
import { findFile } from './tools/lookup';
import { offered, type Item } from './transcript';
import { CHAT_UI } from './tunables';

/** Questions that are true for any repository. */
const EXAMPLES = ['What does this repo do?', 'Where does execution start?', 'Which files change most often?', 'Show me the tests'];

/** Select a file and fly to it, as choosing a search result does. */
function showPath(path: string): void {
  const env = liveEnv();
  const hit = env ? findFile(env.replica, path) : null;
  if (!env || !hit?.ref) return;
  setSelection([hit.ref]);
  env.act.flyTo(hit.ref);
}

/** Open a file on the File tab. */
function openPath(path: string): void {
  liveEnv()?.act.openFile(fileRef(path));
}

function Line({ item, retry }: { item: Item; retry: boolean }) {
  switch (item.kind) {
    case 'user':
      return <div className="gm-chat-user"><span className="gm-visually-hidden">You asked: </span>{item.text}</div>;
    case 'assistant':
      // While it streams the stretch is kept out of the log's announcements; the finished one is put
      // in as a new element (see its key below), so it is announced once, whole.
      return <div className="gm-chat-turn" aria-live={item.streaming ? 'off' : undefined}><Answer text={item.text} streaming={item.streaming} /></div>;
    case 'action':
      return <p className="gm-chat-action"><span className="gm-visually-hidden">The map changed: </span>{item.text}</p>;
    case 'note':
      return <p className="gm-chat-note">{item.text}</p>;
    case 'error':
      return (
        <div className="gm-chat-error">
          <span>{item.text}</span>
          {retry && (
            <PillButton size="small" className="gm-chat-retry" onClick={retryTurn}>
              {item.offer === 'continue' ? 'Continue' : 'Retry'}
            </PillButton>
          )}
        </div>
      );
  }
}

function EmptyState({ ask }: { ask: (question: string) => void }) {
  const repo = useRepoName();
  return (
    <div className="gm-chat-empty">
      <h2 className="gm-chat-empty-title">Ask about {repo ?? 'this repo'}</h2>
      <p className="gm-chat-empty-text">The assistant can look through the map, read files, and point things out on it.</p>
      <ul className="gm-chat-examples" aria-label="Example questions">
        {EXAMPLES.map((question) => (
          <li key={question}>
            <PillButton className="gm-chat-example" onClick={() => ask(question)}>{question}</PillButton>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ChatPanel() {
  const transcript = useChat((s) => s.transcript);
  const draft = useChat((s) => s.draft);
  const focusAsked = usePanel((s) => s.composerFocus);
  const reducedMotion = useReducedMotion();
  const hintId = useId();
  const { items, running, activity } = transcript;
  const retryLine = offered(transcript);

  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  /** The reader is at the end of the transcript, so new text is followed. */
  const following = useRef(true);
  const lastTop = useRef(0);

  // marked and DOMPurify, fetched while the first question is being typed
  useEffect(() => { preloadMarkdown(); }, []);

  // ---- following new text ----
  const toEnd = () => {
    const el = scroller.current;
    if (!el || !following.current) return;
    el.scrollTop = el.scrollHeight;
    lastTop.current = el.scrollTop;
  };
  // Only the reader scrolling back stops the following. A scroll event also arrives late for our own
  // scrolling, after more text has come in below, and that must not count as having left the end.
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight <= CHAT_UI.followSlopPx;
    if (atEnd) following.current = true;
    else if (el.scrollTop < lastTop.current - 1) following.current = false;
    lastTop.current = el.scrollTop;
  };
  useLayoutEffect(toEnd);
  // markdown lands a moment after the text that asked for it, and the panel can be resized
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined' || !content.current) return;
    const observer = new ResizeObserver(toEnd);
    observer.observe(content.current);
    if (scroller.current) observer.observe(scroller.current);
    return () => observer.disconnect();
  }, []);

  // ---- focus ----
  // The chat button asks for the composer. The panel takes the focus for itself as it opens, so wait a frame.
  useEffect(() => {
    if (!takeFocus('composer')) return;
    const frame = requestAnimationFrame(() => field.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [focusAsked]);
  // The field is disabled while a turn runs, so the focus waits on the Stop button and comes back after.
  const wasRunning = useRef(running);
  useLayoutEffect(() => {
    if (wasRunning.current && !running && document.activeElement === button.current) field.current?.focus({ preventScroll: true });
    wasRunning.current = running;
  }, [running]);

  // ---- the composer ----
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = 'auto';
    const line = parseFloat(getComputedStyle(el).lineHeight) || 20;
    el.style.height = `${Math.min(el.scrollHeight, Math.ceil(line * CHAT_UI.composerLines))}px`;
  }, [draft]);

  const canSend = !running && draft.trim() !== '';
  const ask = (question: string) => {
    if (running || question.trim() === '') return;
    following.current = true;
    // before the field is disabled, so the focus is never left on nothing
    button.current?.focus({ preventScroll: true });
    sendMessage(question);
  };
  const submit = () => {
    if (!canSend) return;
    ask(draft);
    setDraft('');
  };
  // Enter sends; Shift+Enter is the field's own new line. Escape and Tab are left alone: Escape
  // closes the panel in its turn (the sidebar registered it), Tab moves on.
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    submit();
  };

  // Path buttons are made outside React (paths.ts), so their clicks are picked up here.
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-chat-path], [data-chat-open]');
    if (!el) return;
    const open = el.dataset.chatOpen;
    if (open !== undefined) openPath(open);
    else if (e.shiftKey) openPath(el.dataset.chatPath!);
    else showPath(el.dataset.chatPath!);
  };

  return (
    <div className={cx('gm-chat', reducedMotion && 'is-still')}>
      {/* A log: what is added is announced, politely. Not while a turn runs (aria-busy), so an answer
          is heard once it is whole rather than word by word; it can be scrolled from the keyboard. */}
      <div
        className="gm-chat-scroll" ref={scroller} tabIndex={0} role="log" aria-label="Conversation" aria-busy={running}
        onScroll={onScroll} onClick={onClick}
      >
        <div className="gm-chat-content" ref={content}>
          {items.length === 0 ? <EmptyState ask={ask} /> : (
            <div className="gm-chat-items">
              {items.map((item) => (
                <Line key={item.kind === 'assistant' && item.streaming ? `${item.id}:streaming` : item.id} item={item} retry={item === retryLine} />
              ))}
            </div>
          )}
          {/* it changes with every look-up, so it is not announced: the actions and the answer are */}
          {activity !== null && <p className="gm-chat-activity" aria-live="off"><span className="gm-chat-pulse" aria-hidden="true" />{activity}</p>}
        </div>
      </div>
      <form className="gm-chat-composer" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <textarea
          ref={field}
          className="gm-chat-field"
          rows={1}
          value={draft}
          placeholder={running ? 'Answering…' : 'Ask about this repo'}
          aria-label="Message to the assistant"
          aria-describedby={hintId}
          disabled={running}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <span className="gm-visually-hidden" id={hintId}>Enter sends the message. Shift+Enter starts a new line.</span>
        {running ? (
          <PillButton ref={button} size="small" className="gm-chat-send is-stop" title="Stop answering" onClick={stopTurn}>
            <StopIcon size={13} />
            Stop
          </PillButton>
        ) : (
          <PillButton
            ref={button} size="small" round type="submit" className="gm-chat-send"
            aria-label="Send" aria-disabled={!canSend} title="Send (Enter)"
          >
            <SendIcon size={15} />
          </PillButton>
        )}
      </form>
    </div>
  );
}
