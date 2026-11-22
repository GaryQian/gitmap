import { describe, expect, it } from 'vitest';
import { EMPTY, STOPPED, THINKING, lastQuestion, offered, reduce, type Transcript, type TranscriptEvent } from './transcript';

const play = (events: TranscriptEvent[], from: Transcript = EMPTY): Transcript => events.reduce(reduce, from);
const shape = (t: Transcript) => t.items.map((i) => `${i.kind}:${i.text}`);

describe('the transcript', () => {
  it('streams deltas into one stretch of the answer and closes it at the end', () => {
    const running = play([{ type: 'send', text: '  What is this?  ' }, { type: 'step' }, { type: 'text', delta: '\n\nIt is ' }, { type: 'text', delta: 'a map.' }]);
    expect(shape(running)).toEqual(['user:What is this?', 'assistant:It is a map.']);
    expect(running).toMatchObject({ running: true, activity: null });
    expect(running.items[1]).toMatchObject({ streaming: true });

    const done = reduce(running, { type: 'end', reason: 'end', notice: null });
    expect(done).toMatchObject({ running: false, activity: null });
    expect(done.items[1]).toMatchObject({ streaming: false });
    expect(new Set(done.items.map((i) => i.id)).size).toBe(done.items.length);
  });

  it('shows one dim line while tools run, and keeps a line for each thing that changed', () => {
    let t = play([
      { type: 'send', text: 'Show me the tests' }, { type: 'step' }, { type: 'text', delta: 'Let me look.' },
      { type: 'tool_call', id: 'a', label: 'Looking over the map…' }, { type: 'tool_call', id: 'b', label: 'Changing the overlay…' },
    ]);
    expect(t.activity).toBe('Looking over the map…');
    t = reduce(t, { type: 'tool_result', id: 'a' });
    expect(t.activity).toBe('Changing the overlay…');
    expect(shape(t)).toEqual(['user:Show me the tests', 'assistant:Let me look.']); // a look-up leaves nothing behind
    t = reduce(t, { type: 'tool_result', id: 'b', action: 'Turned on the Tests overlay' });
    expect(t.activity).toBe(THINKING);
    t = play([{ type: 'step' }, { type: 'text', delta: 'Tests are lit.' }, { type: 'end', reason: 'end', notice: null }], t);
    expect(shape(t)).toEqual(['user:Show me the tests', 'assistant:Let me look.', 'action:Turned on the Tests overlay', 'assistant:Tests are lit.']);
  });

  it('adds a line for what the panel itself showed after a finished answer, and only then', () => {
    const base: TranscriptEvent[] = [{ type: 'send', text: 'Where is the store?' }, { type: 'step' }, { type: 'text', delta: 'In the store file.' }];
    const shown = play([...base, { type: 'end', reason: 'end', notice: null, shown: 'Showing src/app/store.ts' }]);
    expect(shape(shown)).toEqual(['user:Where is the store?', 'assistant:In the store file.', 'action:Showing src/app/store.ts']);
    const stopped = play([...base, { type: 'end', reason: 'aborted', notice: null, shown: 'Showing src/app/store.ts' }]);
    expect(shape(stopped)).toEqual(['user:Where is the store?', 'assistant:In the store file.', `note:${STOPPED}`]);
  });

  it('keeps the partial answer when stopped', () => {
    const t = play([{ type: 'send', text: 'Go on' }, { type: 'step' }, { type: 'text', delta: 'Half an ans' }, { type: 'end', reason: 'aborted', notice: null }]);
    expect(shape(t)).toEqual(['user:Go on', 'assistant:Half an ans', `note:${STOPPED}`]);
    expect(t.running).toBe(false);
    expect(offered(t)).toBeNull();
    // stopped before a word arrived: no empty stretch is left behind
    const early = play([{ type: 'send', text: 'Go on' }, { type: 'step' }, { type: 'text', delta: '  ' }, { type: 'end', reason: 'aborted', notice: null }]);
    expect(shape(early)).toEqual(['user:Go on', `note:${STOPPED}`]);
  });

  it('ends a failed turn with one line that offers to retry, and retrying clears what the attempt wrote', () => {
    let t = play([
      { type: 'send', text: 'Where does it start?' }, { type: 'step' }, { type: 'tool_call', id: 'a', label: 'x' },
      { type: 'tool_result', id: 'a', action: 'Selected 3 files' }, { type: 'step' }, { type: 'text', delta: 'It starts' },
      { type: 'end', reason: 'error', notice: 'Too many AI requests. Try again shortly.' },
    ]);
    expect(offered(t)).toMatchObject({ text: 'Too many AI requests. Try again shortly.', offer: 'retry' });
    expect(lastQuestion(t)).toBe('Where does it start?');
    t = reduce(t, { type: 'retry' });
    expect(shape(t)).toEqual(['user:Where does it start?', 'action:Selected 3 files']); // what changed on the map still shows
    expect(t).toMatchObject({ running: true, activity: THINKING });

    const limit = play([{ type: 'send', text: 'q' }, { type: 'end', reason: 'step_limit', notice: 'Stopped after 8 steps.' }]);
    expect(offered(limit)?.offer).toBe('continue');
    // the offer belongs to the last line only
    expect(offered(play([{ type: 'send', text: 'again' }], limit))).toBeNull();
  });

  it('ignores what cannot apply: an empty message, a second send while running, events after the end', () => {
    expect(reduce(EMPTY, { type: 'send', text: '   ' })).toBe(EMPTY);
    const running = reduce(EMPTY, { type: 'send', text: 'one' });
    expect(reduce(running, { type: 'send', text: 'two' })).toBe(running);
    const over = reduce(running, { type: 'end', reason: 'end', notice: null });
    expect(reduce(over, { type: 'text', delta: 'late' })).toBe(over);
    expect(reduce(over, { type: 'reset' })).toBe(EMPTY);
  });
});
