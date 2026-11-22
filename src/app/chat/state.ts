// The conversation with the assistant about the open map: the transcript on screen, the messages
// the model is sent, and the turn in flight. It lasts for the visit to one map and is never saved.
// The loop itself is src/ai's `runChatTurn`; this file feeds it the executor and turns its events
// into transcript events. Actions are plain functions, like the ones in ../store.
import { create } from 'zustand';
import type { Session } from '../../contracts/pipeline';
import { useApp } from '../store';
import {
  buildChatContext, runChatTurn, toAiErrorInfo,
  type ChatClient, type ChatMessage, type ChatTurnEnd, type ChatTurnEvent,
} from './contract';
import { activityLabel } from './labels';
import { hasSelectionNote, selectionNote, withSelection } from './selectionNote';
import { showReferenced, watchUser } from './show';
import { createToolExecutor } from './tools/executor';
import { liveEnv } from './tools/live';
import { EMPTY, lastQuestion, offered, reduce, type Transcript, type TranscriptEvent } from './transcript';

interface ChatState {
  transcript: Transcript;
  /** What is typed and not yet sent; kept while the panel is closed. */
  draft: string;
}

export const useChat = create<ChatState>()(() => ({ transcript: EMPTY, draft: '' }));

// ---- the conversation behind the transcript (nothing renders from these) ----

/** What the next request carries: every finished turn, as the loop handed it back. */
let history: ChatMessage[] = [];
/** `history` as it was before the last question, for Retry. */
let beforeLast: ChatMessage[] = [];
/** The map overview, built once per conversation so the provider can cache it. */
let context: string | null = null;
let abort: AbortController | null = null;
/** Counts turns and resets: events of a turn that is no longer the current one are dropped. */
let current = 0;
/** A transport put in place of the server's (scripted.ts), or null for the real one. */
let client: ChatClient | null = null;

const executor = createToolExecutor(liveEnv);

function dispatch(event: TranscriptEvent): void {
  useChat.setState((s) => {
    const transcript = reduce(s.transcript, event);
    return transcript === s.transcript ? s : { transcript };
  });
}

/**
 * Use this transport instead of POSTing to /api/ai/chat, or null to go back to the server. For the
 * dev harness, browser checks and tests: with a scripted client no request leaves the page.
 */
export function setChatClient(next: ChatClient | null): void { client = next; }

function fromLoop(event: ChatTurnEvent, session: Session): TranscriptEvent | null {
  switch (event.type) {
    case 'step': return { type: 'step' };
    case 'text': return { type: 'text', delta: event.delta };
    case 'tool_call': return { type: 'tool_call', id: event.call.id, label: activityLabel(event.call, session.replica) };
    case 'tool_result': return { type: 'tool_result', id: event.call.id, action: event.outcome.ok ? event.outcome.action : undefined };
    case 'trimmed': return { type: 'note', text: event.message };
  }
}

async function run(messages: ChatMessage[]): Promise<void> {
  const session = useApp.getState().session;
  const turn = ++current;
  const end = (reason: ChatTurnEnd, notice: string | null, shown?: string) => {
    if (turn === current) dispatch({ type: 'end', reason, notice, shown });
  };
  if (!session) { end('error', 'No map is open.'); return; }
  const controller = new AbortController();
  abort = controller;
  // for showing what the answer references once it is finished (autoshow.ts)
  const tools: { name: string; ok: boolean }[] = [];
  const user = watchUser();
  try {
    context ??= buildChatContext(session.replica);
    const result = await runChatTurn({
      messages, context, executor, signal: controller.signal,
      ...(client ? { client } : {}),
      onEvent: (event) => {
        if (turn !== current) return;
        if (event.type === 'tool_result') {
          tools.push({ name: event.call.name, ok: event.outcome.ok });
          user.sync(); // a selection the assistant changed is not the user's doing
        }
        const mapped = fromLoop(event, session);
        if (mapped) dispatch(mapped);
      },
    });
    if (turn !== current) return;
    history = result.messages;
    const { reason, text, error, notice } = result.summary;
    // The answer names files and the assistant pointed at nothing itself: the map shows them.
    const shown = useApp.getState().session === session
      ? showReferenced(session, { reason, answer: text, tools, userMoved: user.moved() })
      : undefined;
    end(reason, error?.message ?? notice, shown);
  } catch (err) {
    // the loop resolves whatever happens; this is for a bug on the way in or out of it
    console.error('starmap: the chat turn failed', err);
    end('error', toAiErrorInfo(err).message);
  } finally {
    user.stop();
    if (abort === controller) abort = null;
  }
}

/**
 * A question as the model is sent it: with what is selected on the map just now in front of it
 * (selectionNote.ts). The transcript keeps the person's own words.
 */
function asked(question: string, earlier: readonly ChatMessage[]): ChatMessage {
  const { session, selection } = useApp.getState();
  if (!session) return { role: 'user', text: question };
  // once a selection has been named, its going away is named too
  const sayEmpty = earlier.some((m) => m.role === 'user' && hasSelectionNote(m.text));
  return { role: 'user', text: withSelection(question, selectionNote(session.replica, selection, { sayEmpty })) };
}

// ---- actions ----

export function setDraft(draft: string): void { useChat.setState({ draft }); }

/** Ask something. Does nothing while a turn runs or when there is nothing to ask. */
export function sendMessage(text: string): void {
  const question = text.trim();
  const { transcript } = useChat.getState();
  if (question === '' || transcript.running) return;
  dispatch({ type: 'send', text: question });
  beforeLast = history;
  void run([...history, asked(question, history)]);
}

/** Stop the turn in flight. What has been written stays. */
export function stopTurn(): void { abort?.abort(); }

/** The line at the end of the transcript offers it: ask the last question again, or go on from where it stopped. */
export function retryTurn(): void {
  const { transcript } = useChat.getState();
  const line = offered(transcript);
  if (!line) return;
  if (line.offer === 'continue') { sendMessage('Continue'); return; }
  const question = lastQuestion(transcript);
  if (question === null) return;
  dispatch({ type: 'retry' });
  void run([...beforeLast, asked(question, beforeLast)]);
}

/** Forget the conversation. The map stays as the assistant left it. */
export function newChat(): void {
  current++;
  abort?.abort();
  abort = null;
  history = [];
  beforeLast = [];
  context = null;
  useChat.setState({ transcript: EMPTY });
}

// The conversation belongs to one open map: it goes when the map does.
const unsubscribe = useApp.subscribe((s, prev) => {
  if (s.session === prev.session) return;
  newChat();
  useChat.setState({ draft: '' });
});
if (import.meta.hot) import.meta.hot.dispose(unsubscribe);

// This module holds state. Hot-swapping it would leave two copies alive, so reload the page instead.
if (import.meta.hot) import.meta.hot.accept(() => location.reload());
