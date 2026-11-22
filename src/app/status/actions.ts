// From a case to something the store can show: the sentence, and its action bound to what it runs.
import type { LineAction, StatusLine } from '../store';
import { say, type StatusActionId, type StatusCase, type StatusParams } from './messages';

export type ActionRunners = Partial<Record<StatusActionId, () => void | Promise<void>>>;

const reload = (): void => { location.reload(); };

export interface Line { text: string; action: LineAction | null }

/**
 * The line for a case. "Reload" always works; any other action appears only when the caller says
 * what it runs, so a line never carries a button that does nothing.
 */
export function lineFor(id: StatusCase, params: StatusParams = {}, runners: ActionRunners = {}): Line {
  const message = say(id, params);
  const run = message.action ? runners[message.action.id] ?? (message.action.id === 'reload' ? reload : undefined) : undefined;
  return { text: message.text, action: message.action && run ? { label: message.action.label, run } : null };
}

/** The same as a line for the map's top row. `fades` lines go away by themselves. */
export function statusLine(id: StatusCase, opts: { params?: StatusParams; runners?: ActionRunners; fades?: boolean; key?: string } = {}): StatusLine {
  const line = lineFor(id, opts.params, opts.runners);
  const out: StatusLine = { kind: 'status', id: opts.key ?? id, text: line.text };
  if (line.action) out.action = line.action;
  if (opts.fades) out.fades = true;
  return out;
}
