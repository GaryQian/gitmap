// The transcript as a pure reducer: what the panel shows for a conversation, built from the user's
// own actions and the events of the conversation loop. No React, no store; state.ts holds the result.
import type { ChatTurnEnd } from './contract';

export type Item =
  /** What the user asked. */
  | { kind: 'user'; id: number; text: string }
  /** A stretch of the answer. A turn has several when the assistant acts on the map in between. */
  | { kind: 'assistant'; id: number; text: string; streaming: boolean }
  /** Something the assistant changed on the map, in its own words: "Turned on the Recency overlay". */
  | { kind: 'action'; id: number; text: string }
  /** A quiet remark of the panel's own: "Stopped". */
  | { kind: 'note'; id: number; text: string }
  /** Why a turn ended early, as one line, and what the line offers to do about it. */
  | { kind: 'error'; id: number; text: string; offer: 'retry' | 'continue' };

export interface Transcript {
  items: Item[];
  /** A turn is in flight: the composer is disabled and Stop is offered. */
  running: boolean;
  /** The one dim line while something is waited for: "Reading src/app/store.ts…". Null while text streams. */
  activity: string | null;
  /** Tools the model has asked for that have not run yet, oldest first. */
  pending: { id: string; label: string }[];
  nextId: number;
}

export type TranscriptEvent =
  | { type: 'send'; text: string }
  /** Run the last message again: what the failed attempt wrote goes, what it did to the map stays. */
  | { type: 'retry' }
  /** A request to the model is going out. */
  | { type: 'step' }
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; id: string; label: string }
  | { type: 'tool_result'; id: string; action?: string }
  | { type: 'note'; text: string }
  /**
   * The turn is over. `notice` is the sentence for the line when it did not simply end. `shown` is
   * what the panel itself then put on the map for a finished answer (autoshow.ts): "Showing src/a.ts".
   */
  | { type: 'end'; reason: ChatTurnEnd; notice: string | null; shown?: string }
  | { type: 'reset' };

export const THINKING = 'Thinking…';
export const STOPPED = 'Stopped';

export const EMPTY: Transcript = { items: [], running: false, activity: null, pending: [], nextId: 1 };

/** The streaming stretch of the answer, if the transcript ends with one. */
function openAnswer(items: readonly Item[]): (Item & { kind: 'assistant' }) | null {
  const last = items[items.length - 1];
  return last && last.kind === 'assistant' && last.streaming ? last : null;
}

/** The same items with the streaming stretch closed; a stretch that holds no words is dropped. */
function closed(items: Item[]): Item[] {
  const open = openAnswer(items);
  if (!open) return items;
  const rest = items.slice(0, -1);
  return open.text.trim() === '' ? rest : [...rest, { ...open, streaming: false }];
}

const lastUserAt = (items: readonly Item[]): number => {
  for (let i = items.length - 1; i >= 0; i--) if (items[i]!.kind === 'user') return i;
  return -1;
};

export function reduce(t: Transcript, e: TranscriptEvent): Transcript {
  const push = (items: Item[], item: Record<string, unknown>): Item[] => [...items, { ...item, id: t.nextId } as Item];
  switch (e.type) {
    case 'reset':
      return EMPTY;

    case 'send': {
      const text = e.text.trim();
      if (text === '' || t.running) return t;
      return { ...t, items: push(closed(t.items), { kind: 'user', text }), running: true, activity: THINKING, pending: [], nextId: t.nextId + 1 };
    }

    case 'retry': {
      const at = lastUserAt(t.items);
      if (at < 0 || t.running) return t;
      const items = t.items.filter((item, i) => i <= at || item.kind === 'action');
      return { ...t, items, running: true, activity: THINKING, pending: [] };
    }

    case 'step':
      if (!t.running) return t;
      return { ...t, items: closed(t.items), activity: THINKING };

    case 'text': {
      if (!t.running || e.delta === '') return t;
      const open = openAnswer(t.items);
      if (open) return { ...t, items: [...t.items.slice(0, -1), { ...open, text: open.text + e.delta }], activity: null };
      // a stretch never starts with the blank lines a model puts between its steps
      const delta = e.delta.replace(/^\s+/, '');
      if (delta === '') return t;
      return { ...t, items: push(t.items, { kind: 'assistant', text: delta, streaming: true }), activity: null, nextId: t.nextId + 1 };
    }

    case 'tool_call': {
      if (!t.running) return t;
      const pending = [...t.pending, { id: e.id, label: e.label }];
      return { ...t, items: closed(t.items), pending, activity: pending[0]!.label };
    }

    case 'tool_result': {
      if (!t.running) return t;
      const pending = t.pending.filter((p) => p.id !== e.id);
      const activity = pending[0]?.label ?? THINKING;
      if (!e.action) return { ...t, pending, activity };
      return { ...t, items: push(closed(t.items), { kind: 'action', text: e.action }), pending, activity, nextId: t.nextId + 1 };
    }

    case 'note':
      return { ...t, items: push(closed(t.items), { kind: 'note', text: e.text }), nextId: t.nextId + 1 };

    case 'end': {
      if (!t.running) return t;
      const items = closed(t.items);
      const over = { ...t, running: false, activity: null, pending: [] };
      if (e.reason === 'end') {
        return e.shown ? { ...over, items: push(items, { kind: 'action', text: e.shown }), nextId: t.nextId + 1 } : { ...over, items };
      }
      if (e.reason === 'aborted') return { ...over, items: push(items, { kind: 'note', text: STOPPED }), nextId: t.nextId + 1 };
      const text = e.notice ?? 'The answer could not be finished.';
      // a cut-off answer or a run out of steps goes on from where it stopped; anything else starts the message again
      const offer = e.reason === 'step_limit' || e.reason === 'max_tokens' ? 'continue' : 'retry';
      return { ...over, items: push(items, { kind: 'error', text, offer }), nextId: t.nextId + 1 };
    }
  }
}

/** The line that offers Retry or Continue: only the transcript's last line, and only while nothing runs. */
export function offered(t: Transcript): (Item & { kind: 'error' }) | null {
  const last = t.items[t.items.length - 1];
  return !t.running && last && last.kind === 'error' ? last : null;
}

/** The text of the last question, for Retry. */
export function lastQuestion(t: Transcript): string | null {
  const at = lastUserAt(t.items);
  const item = at < 0 ? null : t.items[at]!;
  return item && item.kind === 'user' ? item.text : null;
}
